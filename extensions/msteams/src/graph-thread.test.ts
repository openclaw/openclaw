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
  fetchAllGraphPages: vi.fn(),
  fetchGraphJson: vi.fn(),
}));

const firstFetchAllGraphPagesPath = () => {
  const [call] = vi.mocked(fetchAllGraphPages).mock.calls;
  if (!call) {
    throw new Error("expected paginated Graph fetch call");
  }
  return call[0].path;
};

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
    vi.mocked(fetchGraphJson).mockReset();
  });

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

  it("clamps limit to 50 maximum", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: Array.from({ length: 52 }, (_, index) => ({
        id: `reply-${index + 1}`,
        createdDateTime: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 200);

    expect(firstFetchAllGraphPagesPath()).toContain("$top=50");
    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe("reply-3");
    expect(result.at(-1)?.id).toBe("reply-52");
  });

  it("clamps limit to 1 minimum and keeps the newest reply", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: [
        { id: "oldest", createdDateTime: "2026-01-01T00:00:00Z" },
        { id: "newest", createdDateTime: "2026-01-01T00:01:00Z" },
      ],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 0);

    expect(firstFetchAllGraphPagesPath()).toContain("$top=50");
    expect(result.map((reply) => reply.id)).toEqual(["newest"]);
  });

  it("returns empty array when value is missing", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({ items: [], truncated: false } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m");
    expect(result).toStrictEqual([]);
  });

  it("returns newest limited replies from paginated results", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: [
        { id: "reply-1", createdDateTime: "2026-01-01T00:00:00Z" },
        { id: "reply-2", createdDateTime: "2026-01-01T00:01:00Z" },
        { id: "reply-3", createdDateTime: "2026-01-01T00:02:00Z" },
        { id: "reply-4", createdDateTime: "2026-01-01T00:03:00Z" },
      ],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 3);

    expect(result.map((reply) => reply.id)).toEqual(["reply-2", "reply-3", "reply-4"]);
  });

  it("returns newest limited replies when Graph pages arrive newest-first", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: [
        { id: "reply-4", createdDateTime: "2026-01-01T00:03:00Z" },
        { id: "reply-3", createdDateTime: "2026-01-01T00:02:00Z" },
        { id: "reply-2", createdDateTime: "2026-01-01T00:01:00Z" },
        { id: "reply-1", createdDateTime: "2026-01-01T00:00:00Z" },
      ],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 3);

    expect(result.map((reply) => reply.id)).toEqual(["reply-2", "reply-3", "reply-4"]);
  });

  it("preserves arrival order for replies without parseable dates", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: [
        { id: "reply-1" },
        { id: "reply-2", createdDateTime: "not-a-date" },
        { id: "reply-3" },
      ],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 2);

    expect(result.map((reply) => reply.id)).toEqual(["reply-2", "reply-3"]);
  });

  it("sets a page cap to avoid unbounded pagination", async () => {
    vi.mocked(fetchAllGraphPages).mockResolvedValueOnce({
      items: Array.from({ length: 50 }, (_, index) => ({ id: `reply-${index + 1}` })),
      truncated: true,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m");

    expect(fetchAllGraphPages).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g/channels/c/messages/m/replies?$top=50&$select=id,from,body,createdDateTime",
      maxPages: 50,
    });
    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe("reply-1");
    expect(result.at(-1)?.id).toBe("reply-50");
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
