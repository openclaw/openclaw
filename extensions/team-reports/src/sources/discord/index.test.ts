import { afterEach, expect, it, vi } from "vitest";
import { bindReportFetch } from "../../report-network.test-support.js";
import type { DiscordMessage } from "../../types.js";
import { config, json, message, runtime, thread, window } from "./discord.fixtures.js";
import { createDiscordSource } from "./index.js";

const { sinceMs, untilMs } = window;

async function collect(context: ReturnType<typeof runtime>, sourceConfig = config) {
  const messages = new Map<string, DiscordMessage>();
  const batchSizes: number[] = [];
  const source = bindReportFetch(
    createDiscordSource({ logger: context.logger }),
    context.fetchImpl,
  );
  const status = await source.collect(sourceConfig, window, async (entries) => {
    batchSizes.push(entries.length);
    for (const { key, value } of entries) {
      messages.set(key, value);
    }
  });
  const sorted = [...messages].toSorted(
    ([a, left], [b, right]) =>
      left.atMs - right.atMs || left.channelId.localeCompare(right.channelId) || a.localeCompare(b),
  );
  return { messages: sorted.map(([, entry]) => entry), status, batchSizes };
}

function expectStatus(
  { status }: Awaited<ReturnType<typeof collect>>,
  warnings: unknown[],
  privateArchivesSkipped = 0,
) {
  expect(status).toMatchObject({
    ok: warnings.length === 0,
    warnings,
    stats: { privateArchivesSkipped },
  });
  expect(status.stale === true).toBe(warnings.length > 0);
}

function requestsEnding(context: ReturnType<typeof runtime>, path = "/messages") {
  return context.requests.filter((url) => url.pathname.endsWith(path));
}

function routedRuntime(routes: Record<string, (url: URL) => Response>) {
  return runtime((url) => {
    const path = Object.keys(routes).find((suffix) => url.pathname.endsWith(suffix));
    return path ? routes[path]?.(url) : undefined;
  });
}

function archives(threads: ReturnType<typeof thread>[], has_more = true) {
  return json({ threads, has_more });
}

afterEach(() => vi.useRealTimers());

it("pages forward across reverse-ordered pages and stops at the exclusive upper bound", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => message(sinceMs + index + 1));
  let pages = 0;
  const context = routedRuntime({
    "/messages": (url) => {
      pages += 1;
      if (pages === 1) {
        return json(firstPage.toReversed());
      }
      expect(url.searchParams.get("after")).toBe(firstPage[99]?.id);
      return json([
        message(untilMs + 1),
        message(untilMs),
        message(sinceMs + 200),
        { ...message(sinceMs + 150), author: { id: "31", bot: true } },
        message(sinceMs + 130, "   \n  "),
      ]);
    },
  });
  const result = await collect(context);
  expect([pages, result.batchSizes]).toEqual([2, [100, 1]]);
  expect(result.messages.map((entry) => entry.atMs)).toEqual([
    ...firstPage.map((entry) => Date.parse(entry.timestamp)),
    sinceMs + 200,
  ]);
  expect(result.messages.every((entry) => !entry.authorIsBot && entry.content.trim())).toBe(true);
});

it("rolls active and public archived threads into configured parents and bounds archive paging", async () => {
  const future = untilMs + 1000;
  const design = { ...thread("22", future, 11), name: "design" };
  const older = [
    { ...thread("21", sinceMs + 1000, 11), name: "review" },
    { ...thread("23", sinceMs - 1, 11), name: "old" },
  ];
  let archivePages = 0;
  const context = routedRuntime({
    "/threads/active": () =>
      json({ threads: [design, { id: "90", parent_id: "99", name: "outside" }] }),
    "/channels/20/threads/archived/public": (url) => {
      expect(url.searchParams.get("limit")).toBe("100");
      if (archivePages) {
        expect(url.searchParams.get("before")).toBe(new Date(future).toISOString());
      }
      return archives(archivePages++ ? older : [design]);
    },
    "/messages": (url) => {
      const channelId = url.pathname.split("/").at(-2);
      return json([message(sinceMs + 1, url.pathname, BigInt(channelId ?? "0"))]);
    },
  });
  const result = await collect(context);
  expect(archivePages).toBe(2);
  expect(
    result.messages.map((entry) => [entry.channelId, entry.parentChannelId, entry.channelName]),
  ).toEqual([
    ["20", "20", "engineering"],
    ["21", "20", "engineering/review"],
    ["22", "20", "engineering/design"],
  ]);
  expect(requestsEnding(context)).toHaveLength(3);
});

it("falls back to joined private archives and pages by thread id past old archive timestamps", async () => {
  const newerThread = thread(message(sinceMs - 1000).id, sinceMs - 1);
  const olderThread = thread(message(sinceMs - 2000).id, sinceMs + 1000);
  let joinedPages = 0;
  const context = routedRuntime({
    "/channels/20/threads/archived/private": () => json({}, 403),
    "/users/@me/threads/archived/private": (url) => {
      joinedPages += 1;
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("before")).toBe(joinedPages === 1 ? null : newerThread.id);
      return archives([joinedPages === 1 ? newerThread : olderThread], joinedPages === 1);
    },
    [`/channels/${olderThread.id}/messages`]: () => json([message(sinceMs + 1)]),
  });
  const result = await collect(context);
  expect(result.messages.map((entry) => entry.channelId)).toEqual([olderThread.id]);
  expect(joinedPages).toBe(2);
  expectStatus(result, []);
});

it.each([403, 404])("handles private archive HTTP %s", async (code) => {
  const context = routedRuntime({
    "/threads/archived/private": () => json({}, code),
    "/channels/20/messages": () => json([message(sinceMs + 1)]),
  });
  const result = await collect(context);
  expect(result.messages).toHaveLength(1);
  expectStatus(
    result,
    code === 403 ? [] : [expect.stringMatching(/20.*404/)],
    code === 403 ? 1 : 0,
  );
  expect(requestsEnding(context, "/threads/archived/private")).toHaveLength(code === 403 ? 2 : 1);
});

it("waits 60 seconds for Discord retry_after before retrying", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const context = routedRuntime({
    "/messages": () => {
      attempts += 1;
      return attempts === 1 ? json({ retry_after: 60 }, 429) : json([message(sinceMs + 1)]);
    },
  });
  const pending = collect(context);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(attempts).toBe(2);
  expect(result.messages).toHaveLength(1);
  expect(result.status.stats.apiCalls).toBe(context.requests.length);
});

it("warns on missing channel access and collects accessible sibling channels without exposing tokens", async () => {
  const channels = ["20", "21"].map((id) => ({ id, excerpts: false }));
  const context = routedRuntime({
    "/guilds/10/channels": () => json(channels),
    "/channels/20/messages": () => json({ message: `Missing access ${config.token}` }, 403),
    "/channels/21/messages": () => json([message(sinceMs + 1)]),
  });
  const result = await collect(context, { ...config, channels });
  expectStatus(result, [expect.stringMatching(/20.*403/)]);
  expect(result.messages.map((entry) => entry.channelId)).toEqual(["21"]);
  expect(JSON.stringify({ status: result.status, logs: context.logs })).not.toContain(config.token);
});
