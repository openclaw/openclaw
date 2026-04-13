import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _teamGroupIdCacheForTest,
  fetchChannelMessage,
  fetchThreadReplies,
  fetchThreadRepliesDetailed,
  formatThreadContext,
  listThreadMSTeams,
  resolveTeamGroupId,
  stripHtmlFromTeamsMessage,
} from "./graph-thread.js";
import { fetchGraphJson, resolveGraphToken } from "./graph.js";

vi.mock("./graph.js", () => ({
  fetchGraphJson: vi.fn(),
  resolveGraphToken: vi.fn(),
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
      path: "/teams/group-1/channels/channel-1/messages/msg-1?$select=id,from,body,attachments,createdDateTime",
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
      path: "/teams/g%2F1/channels/c%2F2/messages/m%2F3?$select=id,from,body,attachments,createdDateTime",
    });
  });
});

describe("fetchThreadReplies", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("fetches replies with correct path and default limit", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      value: [{ id: "reply-1" }, { id: "reply-2" }],
    } as never);

    const result = await fetchThreadReplies("tok", "group-1", "channel-1", "msg-1");

    expect(result).toHaveLength(2);
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1/replies?$top=50&$select=id,from,body,attachments,createdDateTime",
    });
  });

  it("clamps limit to 50 maximum", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({ value: [] } as never);

    await fetchThreadReplies("tok", "g", "c", "m", 200);

    const path = vi.mocked(fetchGraphJson).mock.calls[0]?.[0]?.path ?? "";
    expect(path).toContain("$top=50");
  });

  it("clamps limit to 1 minimum", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({ value: [] } as never);

    await fetchThreadReplies("tok", "g", "c", "m", 0);

    const path = vi.mocked(fetchGraphJson).mock.calls[0]?.[0]?.path ?? "";
    expect(path).toContain("$top=1");
  });

  it("returns empty array when value is missing", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m");
    expect(result).toEqual([]);
  });
});

describe("fetchThreadRepliesDetailed", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("paginates replies and marks truncation when the requested limit is reached", async () => {
    vi.mocked(fetchGraphJson)
      .mockResolvedValueOnce({
        value: Array.from({ length: 50 }, (_, index) => ({ id: `reply-${index + 1}` })),
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?page=2",
      } as never)
      .mockResolvedValueOnce({
        value: Array.from({ length: 50 }, (_, index) => ({ id: `reply-${index + 51}` })),
      } as never);

    const result = await fetchThreadRepliesDetailed("tok", "group-1", "channel-1", "msg-1", 75);

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(75);
    expect(vi.mocked(fetchGraphJson).mock.calls[1]?.[0]?.path).toBe("/v1.0/next?page=2");
  });
});

describe("listThreadMSTeams", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
    vi.mocked(resolveGraphToken).mockReset();
    _teamGroupIdCacheForTest.clear();
    vi.mocked(resolveGraphToken).mockResolvedValue("tok");
  });

  it("returns chronological messages with truncation, source ids, and media placeholders", async () => {
    vi.mocked(fetchGraphJson)
      .mockResolvedValueOnce({ id: "team-1" } as never)
      .mockResolvedValueOnce({
        id: "root-1",
        from: { user: { displayName: "Alex", id: "user-1" } },
        body: { content: "Root", contentType: "text" },
        createdDateTime: "2026-04-13T10:00:00Z",
      } as never)
      .mockResolvedValueOnce({
        value: [
          {
            id: "reply-2",
            from: { user: { displayName: "Jordan", id: "user-2" } },
            body: { content: '<img src="x" />', contentType: "html" },
            createdDateTime: "2026-04-13T10:02:00Z",
          },
          {
            id: "reply-1",
            from: { user: { displayName: "Taylor", id: "user-3" } },
            body: { content: "Earlier reply", contentType: "text" },
            createdDateTime: "2026-04-13T10:01:00Z",
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?page=2",
      } as never)
      .mockResolvedValueOnce({
        value: [
          {
            id: "reply-3",
            from: { user: { displayName: "Morgan", id: "user-4" } },
            body: { content: "Later reply", contentType: "text" },
            createdDateTime: "2026-04-13T10:03:00Z",
          },
        ],
      } as never);

    const result = await listThreadMSTeams({
      cfg: {} as never,
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      limit: 2,
    });

    expect(result).toMatchObject({
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      truncated: true,
      unavailableMediaCount: 1,
      sourceIds: ["root-1", "reply-1", "reply-2"],
    });
    expect(result.messages.map((message) => message.id)).toEqual(["root-1", "reply-1", "reply-2"]);
    expect(result.messages[2]).toMatchObject({
      id: "reply-2",
      text: "[media unavailable]",
    });
  });

  it("counts explicit attachments as unavailable media evidence", async () => {
    vi.mocked(fetchGraphJson)
      .mockResolvedValueOnce({ id: "team-1" } as never)
      .mockResolvedValueOnce({
        id: "root-1",
        from: { user: { displayName: "Alex", id: "user-1" } },
        body: { content: "", contentType: "text" },
        attachments: [{ name: "report.pdf", contentType: "application/pdf" }],
        createdDateTime: "2026-04-13T10:00:00Z",
      } as never)
      .mockResolvedValueOnce({ value: [] } as never);

    const result = await listThreadMSTeams({
      cfg: {} as never,
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
    });

    expect(result.unavailableMediaCount).toBe(1);
    expect(result.messages).toEqual([
      expect.objectContaining({
        id: "root-1",
        text: "[media unavailable]",
      }),
    ]);
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
