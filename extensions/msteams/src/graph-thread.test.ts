// Msteams tests cover graph thread plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _teamGroupIdCacheForTest,
  fetchChannelMessage,
  fetchThreadReplies,
  formatThreadContext,
  resolveTeamGroupId,
  stripHtmlFromTeamsMessage,
} from "./graph-thread.js";
import { fetchAllGraphPages, fetchGraphJson } from "./graph.js";

vi.mock("./graph.js", () => ({
  fetchGraphJson: vi.fn(),
  fetchAllGraphPages: vi.fn(),
}));

describe("stripHtmlFromTeamsMessage", () => {
  it("preserves @mention display names from <at> tags", () => {
    expect(stripHtmlFromTeamsMessage("<at>Alice</at> hello")).toBe("@Alice hello");
  });

  it("strips other HTML tags", () => {
    expect(stripHtmlFromTeamsMessage("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtmlFromTeamsMessage("&amp; &lt;b&gt; &quot;x&quot; &#39;y&#39; &nbsp;z")).toBe(
      "& <b> \"x\" 'y' z",
    );
  });

  it("does not double-decode escaped entities (decodes &amp; last)", () => {
    // Graph encodes literally-typed entity text by escaping its '&' to '&amp;'.
    // Decoding '&amp;' first would re-decode the now-bare '&lt;'/'&gt;' into
    // angle brackets, corrupting the user's literal text.
    expect(stripHtmlFromTeamsMessage("The token is &amp;lt;APIKEY&amp;gt;")).toBe(
      "The token is &lt;APIKEY&gt;",
    );
  });

  it("normalizes multiple whitespace to single space", () => {
    expect(stripHtmlFromTeamsMessage("hello   world")).toBe("hello world");
  });

  it("handles <at> tags with attributes", () => {
    expect(stripHtmlFromTeamsMessage('<at id="123">Bob</at> please review')).toBe(
      "@Bob please review",
    );
  });

  it("returns empty string for empty input", () => {
    expect(stripHtmlFromTeamsMessage("")).toBe("");
  });
});

describe("resolveTeamGroupId", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
    _teamGroupIdCacheForTest.clear();
  });

  it("fetches team id from Graph and caches it", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({ id: "group-guid-1" } as never);

    const result = await resolveTeamGroupId("tok", "team-123");
    expect(result).toBe("group-guid-1");
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/team-123?$select=id",
    });
  });

  it("returns cached value without calling Graph again", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({ id: "group-guid-2" } as never);

    await resolveTeamGroupId("tok", "team-456");
    await resolveTeamGroupId("tok", "team-456");

    expect(fetchGraphJson).toHaveBeenCalledTimes(1);
  });

  it("does not cache team ids when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      vi.mocked(fetchGraphJson).mockResolvedValue({ id: "group-guid-boundary" } as never);

      await resolveTeamGroupId("tok", "team-boundary");
      await resolveTeamGroupId("tok", "team-boundary");

      expect(fetchGraphJson).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts cached team ids when the current clock is invalid", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValue({ id: "group-guid-invalid-clock" } as never);

    await resolveTeamGroupId("tok", "team-invalid-clock");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      await resolveTeamGroupId("tok", "team-invalid-clock");
    } finally {
      dateNow.mockRestore();
    }

    expect(fetchGraphJson).toHaveBeenCalledTimes(2);
  });

  it("falls back to conversationTeamId when Graph returns no id", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);

    const result = await resolveTeamGroupId("tok", "team-fallback");
    expect(result).toBe("team-fallback");
  });
});

describe("fetchChannelMessage", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("fetches the parent message with correct path", async () => {
    const mockMsg = { id: "msg-1", body: { content: "hello", contentType: "text" } };
    vi.mocked(fetchGraphJson).mockResolvedValueOnce(mockMsg as never);

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");

    expect(result).toEqual(mockMsg);
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1?$select=id,from,body,createdDateTime",
    });
  });

  it("returns undefined on fetch error", async () => {
    vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("forbidden") as never);

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");
    expect(result).toBeUndefined();
  });

  it("URL-encodes group, channel, and message IDs", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);

    await fetchChannelMessage("tok", "g/1", "c/2", "m/3");

    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g%2F1/channels/c%2F2/messages/m%2F3?$select=id,from,body,createdDateTime",
    });
  });
});

describe("fetchThreadReplies", () => {
  beforeEach(() => {
    vi.mocked(fetchAllGraphPages).mockReset();
  });

  const firstPagesPath = () => {
    const [call] = vi.mocked(fetchAllGraphPages).mock.calls;
    if (!call) {
      throw new Error("expected Graph pages call");
    }
    return (call[0] as { path: string }).path;
  };

  it("fetches replies with correct path and default limit", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: [{ id: "reply-1" }, { id: "reply-2" }],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "group-1", "channel-1", "msg-1");

    expect(result).toHaveLength(2);
    expect(fetchAllGraphPages).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1/replies?$top=50&$select=id,from,body,createdDateTime",
      maxPages: 50,
    });
  });

  it("follows pagination and keeps the newest replies (Graph returns oldest-first)", async () => {
    const replies = Array.from({ length: 60 }, (_, i) => ({ id: `reply-${i + 1}` }));
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: replies,
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 50);

    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe("reply-11");
    expect(result.at(-1)?.id).toBe("reply-60");
  });

  it("selects the newest replies by createdDateTime regardless of page order", async () => {
    const items = [
      { id: "c", createdDateTime: "2026-01-03T00:00:00Z" },
      { id: "a", createdDateTime: "2026-01-01T00:00:00Z" },
      { id: "b", createdDateTime: "2026-01-02T00:00:00Z" },
    ];
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({ items, truncated: false } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 2);

    expect(result.map((r) => r.id)).toStrictEqual(["b", "c"]);
  });

  it("clamps per-page $top to 50 maximum", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({ items: [], truncated: false } as never);

    await fetchThreadReplies("tok", "g", "c", "m", 200);

    expect(firstPagesPath()).toContain("$top=50");
  });

  it("clamps per-page $top to 1 minimum", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({ items: [], truncated: false } as never);

    await fetchThreadReplies("tok", "g", "c", "m", 0);

    expect(firstPagesPath()).toContain("$top=1");
  });

  it("returns empty array when there are no replies", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({ items: [], truncated: false } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m");
    expect(result).toStrictEqual([]);
  });
});

describe("formatThreadContext", () => {
  it("formats messages as sender: content lines", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "Hello!", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "World!", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Alice: Hello!\nBob: World!");
  });

  it("skips the current message by id", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "Hello!", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "Current", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages, "m2")).toBe("Alice: Hello!");
  });

  it("strips HTML from html contentType messages", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Carol" } },
        body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Carol: Hello world");
  });

  it("uses application displayName when user is absent", () => {
    const messages = [
      {
        id: "m1",
        from: { application: { displayName: "BotApp" } },
        body: { content: "automated msg", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("BotApp: automated msg");
  });

  it("skips messages with empty content", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "actual content", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Bob: actual content");
  });

  it("falls back to 'unknown' sender when from is missing", () => {
    const messages = [
      {
        id: "m1",
        body: { content: "orphan msg", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("unknown: orphan msg");
  });

  it("returns empty string for empty messages array", () => {
    expect(formatThreadContext([])).toBe("");
  });
});
