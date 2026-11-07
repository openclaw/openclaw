import { afterEach, expect, it, vi } from "vitest";
import { MAX_API_RESPONSE_BYTES } from "../../limits.js";
import { bindReportFetch } from "../../report-network.test-support.js";
import type { DiscordMessage } from "../../types.js";
import {
  archives,
  config,
  expectStatus,
  json,
  message,
  oversizedPage,
  runtime,
  thread,
  window,
} from "./discord.fixtures.js";
import { createDiscordSource } from "./index.js";

const { sinceMs, untilMs } = window;

async function collect(routes: Record<string, (url: URL) => Response>, channels = config.channels) {
  const context = runtime((url) => {
    const path = Object.keys(routes).find((suffix) => url.pathname.endsWith(suffix));
    return path ? routes[path]?.(url) : undefined;
  });
  const messages: DiscordMessage[] = [];
  const source = bindReportFetch(createDiscordSource(context), context.fetchImpl);
  const status = await source.collect({ ...config, channels }, window, async (entries) => {
    messages.push(...entries.map(({ value }) => value));
  });
  messages.sort((a, b) => a.atMs - b.atMs || a.channelId.localeCompare(b.channelId));
  return { messages, status, requests: context.requests, logs: context.logs };
}

afterEach(() => vi.useRealTimers());

it("pages forward across reverse-ordered pages and stops at the exclusive upper bound", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => message(sinceMs + index + 1));
  let pages = 0;
  const result = await collect({
    "/messages": (url) => {
      pages += 1;
      if (pages === 1) {
        return json(firstPage.toReversed());
      }
      expect(url.searchParams.get("after")).toBe(firstPage[99]?.id);
      return json([
        message(untilMs),
        message(sinceMs + 200),
        { ...message(sinceMs + 150), author: { id: "31", bot: true } },
        message(sinceMs + 130, "   \n  "),
      ]);
    },
  });
  expect(result.messages.map((entry) => entry.atMs)).toEqual([
    ...firstPage.map((entry) => Date.parse(entry.timestamp)),
    sinceMs + 200,
  ]);
  expect(result.messages.every((entry) => !entry.authorIsBot && entry.content.trim())).toBe(true);
});

it("rolls active and public archived threads into configured parents and bounds archive paging", async () => {
  const future = untilMs + 1000;
  const design = { ...thread("22", future, 11), name: "design" };
  const older = [thread("21", sinceMs + 1000, 11), thread("23", sinceMs - 1, 11)];
  const result = await collect({
    "/threads/active": () =>
      json({ threads: [design, { id: "90", parent_id: "99", name: "outside" }] }),
    "/channels/20/threads/archived/public": (url) =>
      archives(
        url.searchParams.get("before") === new Date(future).toISOString() ? older : [design],
      ),
    "/messages": (url) => {
      const channelId = url.pathname.split("/").at(-2);
      return json([message(sinceMs + 1, url.pathname, BigInt(channelId ?? "0"))]);
    },
  });
  expectStatus(result.status, []);
  expect(
    result.messages.map((entry) => [entry.channelId, entry.parentChannelId, entry.channelName]),
  ).toEqual([
    ["20", "20", "engineering"],
    ["21", "20", "engineering/discussion"],
    ["22", "20", "engineering/design"],
  ]);
});

it("falls back to joined private archives and pages by thread id past old archive timestamps", async () => {
  const newerThread = thread(message(sinceMs - 1000).id, sinceMs - 1);
  const olderThread = thread(message(sinceMs - 2000).id, sinceMs + 1000);
  let joinedPages = 0;
  const result = await collect({
    "/channels/20/threads/archived/private": () => json({}, 403),
    "/users/@me/threads/archived/private": (url) => {
      joinedPages += 1;
      expect(url.searchParams.get("before")).toBe(joinedPages === 1 ? null : newerThread.id);
      return archives([joinedPages === 1 ? newerThread : olderThread], joinedPages === 1);
    },
    [`/channels/${olderThread.id}/messages`]: () => json([message(sinceMs + 1)]),
  });
  expect(result.messages.map((entry) => entry.channelId)).toEqual([olderThread.id]);
  expectStatus(result.status, []);
});

it.each([403, 404])("handles private archive HTTP %s", async (code) => {
  const result = await collect({
    "/threads/archived/private": () => json({}, code),
    "/channels/20/messages": () => json([message(sinceMs + 1)]),
  });
  expect(result.messages).toHaveLength(1);
  const warnings = code === 404 ? [expect.stringMatching(/20.*404/)] : [];
  expectStatus(result.status, warnings, code === 403 ? 1 : 0);
});

it("waits 60 seconds for Discord retry_after before retrying", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const pending = collect({
    "/messages": () => {
      attempts += 1;
      return attempts === 1 ? json({ retry_after: 60 }, 429) : json([message(sinceMs + 1)]);
    },
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(result.messages).toHaveLength(1);
  expect(result.status.stats.apiCalls).toBe(result.requests.length);
});

it("reports an oversized message page once instead of retrying it", async () => {
  const result = await collect({ "/messages": () => oversizedPage() });
  expectStatus(result.status, [expect.stringMatching(/channel 20.*32 MiB limit.*regenerate/)]);
  // The warning names the bytes read, so an operator sees where the cutoff tripped.
  const read = /\(read ([\d,]+) bytes before the cutoff\)/u.exec(result.status.warnings[0] ?? "");
  expect(Number(read?.[1]?.replaceAll(",", ""))).toBeGreaterThan(MAX_API_RESPONSE_BYTES);
  expect(result.requests.filter((url) => url.pathname.endsWith("/messages"))).toHaveLength(1);
});

it("warns on missing channel access and collects accessible sibling channels without exposing tokens", async () => {
  const channels = ["20", "21"].map((id) => ({ id, excerpts: false }));
  const result = await collect(
    {
      "/guilds/10/channels": () => json(channels),
      "/channels/20/messages": () => json({ message: `Missing access ${config.token}` }, 403),
      "/channels/21/messages": () => json([message(sinceMs + 1)]),
    },
    channels,
  );
  expectStatus(result.status, [expect.stringMatching(/20.*403/)]);
  expect(result.messages.map((entry) => entry.channelId)).toEqual(["21"]);
  expect(JSON.stringify({ status: result.status, logs: result.logs })).not.toContain(config.token);
});
