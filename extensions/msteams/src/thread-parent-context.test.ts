import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphThreadMessage } from "./graph-thread.js";

const { fetchChannelMessage } = vi.hoisted(() => ({
  fetchChannelMessage: vi.fn<typeof import("./graph-thread.js").fetchChannelMessage>(),
}));
vi.mock("./graph-thread.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph-thread.js")>()),
  fetchChannelMessage,
}));

let parentContext: typeof import("./thread-parent-context.js");

async function loadParentContextModule() {
  vi.resetModules();
  fetchChannelMessage.mockReset();
  parentContext = await import("./thread-parent-context.js");
}

beforeAll(loadParentContextModule);

function message(
  content: string,
  from?: GraphThreadMessage["from"],
  contentType: "text" | "html" = "text",
): GraphThreadMessage {
  return { id: "p1", from, body: { content, contentType } };
}

describe("summarizeParentMessage", () => {
  it.each([
    ["missing message", undefined, undefined],
    ["blank body", message("   ", { user: { displayName: "Alice" } }), undefined],
    [
      "HTML",
      message("<p>Hi <b>there</b></p>", { user: { displayName: "Bob" } }, "html"),
      { sender: "Bob", text: "Hi there" },
    ],
    [
      "application sender",
      message("heads up", { application: { displayName: "BotApp" } }),
      { sender: "BotApp", text: "heads up" },
    ],
    ["missing sender", message("orphan"), { sender: "unknown", text: "orphan" }],
  ] as const)("summarizes %s", (_label, input, expected) => {
    expect(parentContext.summarizeParentMessage(input)).toEqual(expected);
  });

  it("collapses whitespace in text contentType", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { user: { displayName: "Carol" } },
      body: { content: "line one\n  line two\t\ttrailing", contentType: "text" },
    };
    expect(parentContext.summarizeParentMessage(msg)).toEqual({
      sender: "Carol",
      text: "line one line two trailing",
    });
  });

  it("keeps truncated parent text well-formed when truncating surrogate pairs", () => {
    const summary = parentContext.summarizeParentMessage(
      message(`${"a".repeat(398)}🦞${"b".repeat(50)}`, { user: { displayName: "Dana" } }),
    );

    expect(summary?.text).toBe(`${"a".repeat(398)}…`);
  });
});

describe("fetchParentMessageCached", () => {
  beforeEach(loadParentContextModule);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches a parent once and returns the cached value on repeat calls", async () => {
    const mockMsg = message("hi");
    const fetcher = fetchChannelMessage.mockImplementation(async () => mockMsg);

    const first = await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");

    expect(first).toEqual(mockMsg);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("tok", "g1", "c1", "p1", undefined);

    const third = await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(third).toEqual(mockMsg);
  });

  it("caches undefined (Graph error) so failures do not re-fetch on burst", async () => {
    const fetcher = fetchChannelMessage.mockImplementation(async () => undefined);

    const first = await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");
    const second = await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("scopes cache by groupId/channelId/parentId", async () => {
    const fetcher = fetchChannelMessage.mockImplementation(async (_tok, _g, _c, parentId) => ({
      id: parentId,
      body: { content: `content-${parentId}`, contentType: "text" },
    }));

    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");
    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p2");
    await parentContext.fetchParentMessageCached("tok", "g2", "c1", "p1");

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("re-fetches after TTL expires", async () => {
    vi.useFakeTimers();
    const fetcher = fetchChannelMessage.mockResolvedValue(message("hi"));

    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries when exceeding the 100-entry cap", async () => {
    const fetcher = fetchChannelMessage.mockImplementation(async (_tok, _g, _c, parentId) => ({
      id: parentId,
      body: { content: `v-${parentId}`, contentType: "text" },
    }));

    // Fill cache with 100 distinct parents.
    for (let i = 0; i < 100; i += 1) {
      await parentContext.fetchParentMessageCached("tok", "g1", "c1", `p${i}`);
    }
    expect(fetcher).toHaveBeenCalledTimes(100);

    // First entry should still be cached (no evictions yet).
    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p0");
    expect(fetcher).toHaveBeenCalledTimes(100);

    // Push one more distinct parent to trigger an eviction.
    // The just-touched p0 is now the newest; the next-oldest (p1) should be evicted.
    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p100");
    expect(fetcher).toHaveBeenCalledTimes(101);

    // Fetching p1 again should miss the cache.
    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p1");
    expect(fetcher).toHaveBeenCalledTimes(102);

    // p0 is still cached because we refreshed it.
    await parentContext.fetchParentMessageCached("tok", "g1", "c1", "p0");
    expect(fetcher).toHaveBeenCalledTimes(102);
  });
});

describe("shouldInjectParentContext / markParentContextInjected", () => {
  beforeEach(loadParentContextModule);

  it("deduplicates a marked parent while keeping other parents and sessions independent", () => {
    expect(parentContext.shouldInjectParentContext("session-1", "parent-1")).toBe(true);

    parentContext.markParentContextInjected("session-1", "parent-1");

    expect(parentContext.shouldInjectParentContext("session-1", "parent-1")).toBe(false);
    expect(parentContext.shouldInjectParentContext("session-1", "parent-2")).toBe(true);
    expect(parentContext.shouldInjectParentContext("session-2", "parent-1")).toBe(true);
  });
});
