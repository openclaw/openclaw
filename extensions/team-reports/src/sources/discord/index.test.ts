import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordMessage, DiscordSource, SourceRuntime } from "../../types.js";
import { config, json, message, runtime, thread, window } from "./discord.fixtures.js";
import { createDiscordSource } from "./index.js";

async function collect(
  context: SourceRuntime,
  sourceConfig: Parameters<DiscordSource["collect"]>[0],
  activityWindow: Parameters<DiscordSource["collect"]>[1],
) {
  const messages = new Map<string, DiscordMessage>();
  const batchSizes: number[] = [];
  const status = await createDiscordSource(context).collect(
    sourceConfig,
    activityWindow,
    async (entries) => {
      batchSizes.push(entries.length);
      for (const { key, value } of entries) {
        messages.set(key, value);
      }
    },
  );
  return {
    messages: [...messages]
      .toSorted(
        ([leftId, left], [rightId, right]) =>
          left.atMs - right.atMs ||
          left.channelId.localeCompare(right.channelId) ||
          leftId.localeCompare(rightId),
      )
      .map(([, entry]) => entry),
    status,
    batchSizes,
  };
}

afterEach(() => vi.useRealTimers());

describe("Discord report source", () => {
  it("pages forward across reverse-ordered pages and stops at the exclusive upper bound", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      message(window.sinceMs + index + 1),
    );
    let pages = 0;
    const context = runtime((url) => {
      if (!url.pathname.endsWith("/messages")) {
        return undefined;
      }
      pages += 1;
      if (pages === 1) {
        return json(firstPage.toReversed());
      }
      expect(url.searchParams.get("after")).toBe(firstPage[99]?.id);
      return json([
        message(window.untilMs + 1),
        message(window.untilMs),
        message(window.sinceMs + 200),
        { ...message(window.sinceMs + 150), author: { id: "31", bot: true } },
        message(window.sinceMs + 130, "   \n  "),
      ]);
    });
    const result = await collect(context, config, window);
    expect(pages).toBe(2);
    expect(result.batchSizes).toEqual([100, 1]);
    expect(result.messages).toHaveLength(101);
    expect(result.messages.map((entry) => entry.atMs)).toEqual([
      ...firstPage.map((entry) => Date.parse(entry.timestamp)),
      window.sinceMs + 200,
    ]);
    expect(result.messages.every((entry) => !entry.authorIsBot && entry.content.trim())).toBe(true);
  });

  it.each([["public", 11]])(
    "rolls active and %s archived threads into configured parents and bounds archive paging",
    async (archiveKind, type) => {
      const archiveTimes = [window.untilMs + 1000, window.sinceMs + 1000, window.sinceMs - 1];
      let archivePages = 0;
      const context = runtime((url) => {
        if (url.pathname.endsWith("/threads/active")) {
          return json({
            threads: [
              { id: "22", parent_id: "20", name: "design", type },
              { id: "90", parent_id: "99", name: "outside" },
            ],
          });
        }
        if (url.pathname.endsWith(`/channels/20/threads/archived/${archiveKind}`)) {
          expect(url.searchParams.get("limit")).toBe("100");
          archivePages += 1;
          if (archivePages === 1) {
            return json({
              threads: [{ ...thread("22", archiveTimes[0] ?? 0, type), name: "design" }],
              has_more: true,
            });
          }
          expect(url.searchParams.get("before")).toBe(new Date(archiveTimes[0] ?? 0).toISOString());
          return json({
            threads: [
              { ...thread("21", archiveTimes[1] ?? 0, type), name: "review" },
              { ...thread("23", archiveTimes[2] ?? 0, type), name: "old" },
            ],
            has_more: true,
          });
        }
        if (url.pathname.endsWith("/messages")) {
          const channelId = url.pathname.split("/").at(-2);
          return json([message(window.sinceMs + 1, url.pathname, BigInt(channelId ?? "0"))]);
        }
        return undefined;
      });
      const result = await collect(context, config, window);
      expect(archivePages).toBe(2);
      expect(
        result.messages.map(({ channelId, parentChannelId, channelName }) => ({
          channelId,
          parentChannelId,
          channelName,
        })),
      ).toEqual([
        { channelId: "20", parentChannelId: "20", channelName: "engineering" },
        { channelId: "21", parentChannelId: "20", channelName: "engineering/review" },
        { channelId: "22", parentChannelId: "20", channelName: "engineering/design" },
      ]);
      expect(context.requests.filter((url) => url.pathname.endsWith("/messages"))).toHaveLength(3);
    },
  );

  it("falls back to joined private archives and pages by thread id past old archive timestamps", async () => {
    const newerThread = thread(message(window.sinceMs - 1000).id, window.sinceMs - 1);
    const olderThread = thread(message(window.sinceMs - 2000).id, window.sinceMs + 1000);
    let joinedPages = 0;
    const context = runtime((url) => {
      if (url.pathname.endsWith("/channels/20/threads/archived/private")) {
        return json({}, 403);
      }
      if (url.pathname.endsWith("/users/@me/threads/archived/private")) {
        joinedPages += 1;
        expect(url.searchParams.get("limit")).toBe("100");
        expect(url.searchParams.get("before")).toBe(joinedPages === 1 ? null : newerThread.id);
        return json({
          threads: [joinedPages === 1 ? newerThread : olderThread],
          has_more: joinedPages === 1,
        });
      }
      if (url.pathname.endsWith(`/channels/${olderThread.id}/messages`)) {
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const result = await collect(context, config, window);
    expect(result.messages.map((entry) => entry.channelId)).toEqual([olderThread.id]);
    expect(joinedPages).toBe(2);
    expect(result.status.warnings).toEqual([]);
    expect(result.status.stale).not.toBe(true);
    expect(result.status.stats.privateArchivesSkipped).toBe(0);
  });

  it("counts inaccessible private archives without warnings or stale status when both endpoints return 403", async () => {
    const context = runtime((url) => {
      if (url.pathname.endsWith("/threads/archived/private")) {
        return json({}, 403);
      }
      if (url.pathname.endsWith("/channels/20/messages")) {
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const result = await collect(context, config, window);
    expect(result.messages).toHaveLength(1);
    expect(result.status.ok).toBe(true);
    expect(result.status.stale).not.toBe(true);
    expect(result.status.warnings).toEqual([]);
    expect(result.status.stats.privateArchivesSkipped).toBe(1);
    expect(
      context.requests.filter((url) => url.pathname.endsWith("/threads/archived/private")),
    ).toHaveLength(2);
  });

  it.each(["primary"])("warns on non-403 failures from %s private archives", async (endpoint) => {
    const context = runtime((url) => {
      if (url.pathname.endsWith("/channels/20/threads/archived/private")) {
        return json({}, endpoint === "primary" ? 404 : 403);
      }
      if (url.pathname.endsWith("/users/@me/threads/archived/private")) {
        return json({}, 404);
      }
      return undefined;
    });
    const result = await collect(context, config, window);
    expect(result.status.warnings).toEqual([expect.stringMatching(/20.*404/)]);
    expect(result.status.stale).toBe(true);
    expect(result.status.ok).toBe(false);
    expect(result.status.stats.privateArchivesSkipped).toBe(0);
  });

  it.each([60])("waits %s seconds for Discord retry_after before retrying", async (seconds) => {
    vi.useFakeTimers();
    let attempts = 0;
    const context = runtime((url) => {
      if (url.pathname.endsWith("/messages")) {
        attempts += 1;
        return attempts === 1
          ? json({ retry_after: seconds }, 429)
          : json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const pending = collect(context, config, window);
    await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(attempts).toBe(2);
    expect(result.messages).toHaveLength(1);
    expect(result.status.stats.apiCalls).toBe(context.requests.length);
  });

  it("warns on missing channel access and collects accessible sibling channels without exposing tokens", async () => {
    const context = runtime((url) => {
      if (url.pathname.endsWith("/guilds/10/channels")) {
        return json([
          { id: "20", name: "restricted" },
          { id: "21", name: "general" },
        ]);
      }
      if (url.pathname.endsWith("/channels/20/messages")) {
        return json({ message: `Missing access ${config.token}` }, 403);
      }
      if (url.pathname.endsWith("/channels/21/messages")) {
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const result = await collect(
      context,
      {
        ...config,
        channels: [
          { id: "20", excerpts: false },
          { id: "21", excerpts: false },
        ],
      },
      window,
    );
    expect(result.status.ok).toBe(false);
    expect(result.status.stale).toBe(true);
    expect(result.status.warnings).toEqual([expect.stringMatching(/20.*403/)]);
    expect(result.messages.map((entry) => entry.channelId)).toEqual(["21"]);
    expect(JSON.stringify({ status: result.status, logs: context.logs })).not.toContain(
      config.token,
    );
  });
});
