import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  fetchGraphJson: vi.fn(),
  postGraphJson: vi.fn(),
}));

type GraphThreadModule = typeof import("./graph-thread.js");

async function loadGraphThreadModule(): Promise<GraphThreadModule> {
  vi.resetModules();
  vi.doMock("./graph.js", () => ({
    fetchGraphJson: mockState.fetchGraphJson,
    postGraphJson: mockState.postGraphJson,
  }));
  return await import("./graph-thread.js");
}

describe("stripHtmlFromTeamsMessage", () => {
  it("preserves @mention display names from <at> tags", async () => {
    const { stripHtmlFromTeamsMessage } = await loadGraphThreadModule();
    expect(stripHtmlFromTeamsMessage("<at>Alice</at> hello")).toBe("@Alice hello");
  });

  it("strips other HTML tags", async () => {
    const { stripHtmlFromTeamsMessage } = await loadGraphThreadModule();
    expect(stripHtmlFromTeamsMessage("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes common HTML entities", async () => {
    const { stripHtmlFromTeamsMessage } = await loadGraphThreadModule();
    expect(stripHtmlFromTeamsMessage("&amp; &lt;b&gt; &quot;x&quot; &#39;y&#39; &nbsp;z")).toBe(
      "& <b> \"x\" 'y' z",
    );
  });

  it("normalizes multiple whitespace to single space", async () => {
    const { stripHtmlFromTeamsMessage } = await loadGraphThreadModule();
    expect(stripHtmlFromTeamsMessage("hello   world")).toBe("hello world");
  });

  it("handles <at> tags with attributes", async () => {
    const { stripHtmlFromTeamsMessage } = await loadGraphThreadModule();
    expect(stripHtmlFromTeamsMessage('<at id="123">Bob</at> please review')).toBe(
      "@Bob please review",
    );
  });

  it("returns empty string for empty input", async () => {
    const { stripHtmlFromTeamsMessage } = await loadGraphThreadModule();
    expect(stripHtmlFromTeamsMessage("")).toBe("");
  });
});

describe("resolveTeamGroupId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches team id from Graph and caches it", async () => {
    const module = await loadGraphThreadModule();
    module._teamGroupIdCacheForTest.clear();
    mockState.fetchGraphJson.mockResolvedValueOnce({ id: "group-guid-1" });

    const result = await module.resolveTeamGroupId("tok", "group-guid-1");
    expect(result).toBe("group-guid-1");
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-guid-1?$select=id",
    });
  });

  it("returns cached value without calling Graph again", async () => {
    const module = await loadGraphThreadModule();
    module._teamGroupIdCacheForTest.clear();
    mockState.fetchGraphJson.mockResolvedValueOnce({ id: "group-guid-2" });

    await module.resolveTeamGroupId("tok", "group-guid-2");
    await module.resolveTeamGroupId("tok", "group-guid-2");

    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(1);
  });

  it("preserves a Graph-looking team id without caching a failed lookup", async () => {
    const module = await loadGraphThreadModule();
    module._teamGroupIdCacheForTest.clear();
    mockState.fetchGraphJson.mockRejectedValueOnce(new Error("forbidden"));

    const result = await module.resolveTeamGroupId("tok", "12345678-1234-1234-1234-1234567890ab");
    expect(result).toBe("12345678-1234-1234-1234-1234567890ab");
    expect(module._teamGroupIdCacheForTest.size).toBe(0);
  });

  it("strips the Graph API version from nextLink pagination paths", async () => {
    const module = await loadGraphThreadModule();
    module._teamGroupIdCacheForTest.clear();
    mockState.fetchGraphJson
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({
        value: [{ id: "group-guid-1" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/groups?$skiptoken=page-2&$select=id&$top=999",
      })
      .mockResolvedValueOnce({
        value: [{ id: "group-guid-2" }],
      });
    mockState.postGraphJson
      .mockResolvedValueOnce({
        responses: [{ id: "0", status: 200, body: { id: "different-primary" } }],
      })
      .mockResolvedValueOnce({
        responses: [{ id: "0", status: 200, body: { id: "team-runtime-key" } }],
      });

    const result = await module.resolveTeamGroupId("tok", "team-runtime-key");

    expect(result).toBe("group-guid-2");
    expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(3, {
      token: "tok",
      path: "/groups?$skiptoken=page-2&$select=id&$top=999",
    });
  });

  it("batches primary-channel lookups instead of fetching each team sequentially", async () => {
    const module = await loadGraphThreadModule();
    module._teamGroupIdCacheForTest.clear();
    mockState.fetchGraphJson.mockRejectedValueOnce(new Error("not found")).mockResolvedValueOnce({
      value: [{ id: "group-guid-1" }, { id: "group-guid-2" }],
    });
    mockState.postGraphJson.mockResolvedValueOnce({
      responses: [
        { id: "0", status: 200, body: { id: "different-primary" } },
        { id: "1", status: 200, body: { id: "team-runtime-key" } },
      ],
    });

    const result = await module.resolveTeamGroupId("tok", "team-runtime-key");

    expect(result).toBe("group-guid-2");
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/$batch",
      body: {
        requests: [
          {
            id: "0",
            method: "GET",
            url: "/teams/group-guid-1/primaryChannel?$select=id",
          },
          {
            id: "1",
            method: "GET",
            url: "/teams/group-guid-2/primaryChannel?$select=id",
          },
        ],
      },
    });
  });
});

describe("fetchChannelMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the parent message with correct path", async () => {
    const { fetchChannelMessage } = await loadGraphThreadModule();
    const mockMsg = { id: "msg-1", body: { content: "hello", contentType: "text" } };
    mockState.fetchGraphJson.mockResolvedValueOnce(mockMsg);

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");

    expect(result).toEqual(mockMsg);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1?$select=id,from,body,createdDateTime",
    });
  });

  it("returns undefined on fetch error", async () => {
    const { fetchChannelMessage } = await loadGraphThreadModule();
    mockState.fetchGraphJson.mockRejectedValueOnce(new Error("forbidden"));

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");
    expect(result).toBeUndefined();
  });

  it("URL-encodes group, channel, and message IDs", async () => {
    const { fetchChannelMessage } = await loadGraphThreadModule();
    mockState.fetchGraphJson.mockResolvedValueOnce({});

    await fetchChannelMessage("tok", "g/1", "c/2", "m/3");

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g%2F1/channels/c%2F2/messages/m%2F3?$select=id,from,body,createdDateTime",
    });
  });
});

describe("fetchThreadReplies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches replies with correct path and default limit", async () => {
    const { fetchThreadReplies } = await loadGraphThreadModule();
    mockState.fetchGraphJson.mockResolvedValueOnce({
      value: [{ id: "reply-1" }, { id: "reply-2" }],
    });

    const result = await fetchThreadReplies("tok", "group-1", "channel-1", "msg-1");

    expect(result).toHaveLength(2);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1/replies?$top=50&$select=id,from,body,createdDateTime",
    });
  });

  it("clamps limit to 50 maximum", async () => {
    const { fetchThreadReplies } = await loadGraphThreadModule();
    mockState.fetchGraphJson.mockResolvedValueOnce({ value: [] });

    await fetchThreadReplies("tok", "g", "c", "m", 200);

    const path = mockState.fetchGraphJson.mock.calls[0]?.[0]?.path ?? "";
    expect(path).toContain("$top=50");
  });

  it("clamps limit to 1 minimum", async () => {
    const { fetchThreadReplies } = await loadGraphThreadModule();
    mockState.fetchGraphJson.mockResolvedValueOnce({ value: [] });

    await fetchThreadReplies("tok", "g", "c", "m", 0);

    const path = mockState.fetchGraphJson.mock.calls[0]?.[0]?.path ?? "";
    expect(path).toContain("$top=1");
  });

  it("returns empty array when value is missing", async () => {
    const { fetchThreadReplies } = await loadGraphThreadModule();
    mockState.fetchGraphJson.mockResolvedValueOnce({});

    const result = await fetchThreadReplies("tok", "g", "c", "m");
    expect(result).toEqual([]);
  });
});

describe("formatThreadContext", () => {
  it("formats messages as sender: content lines", async () => {
    const { formatThreadContext } = await loadGraphThreadModule();
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

  it("skips the current message by id", async () => {
    const { formatThreadContext } = await loadGraphThreadModule();
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

  it("strips HTML from html contentType messages", async () => {
    const { formatThreadContext } = await loadGraphThreadModule();
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Carol" } },
        body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Carol: Hello world");
  });

  it("uses application displayName when user is absent", async () => {
    const { formatThreadContext } = await loadGraphThreadModule();
    const messages = [
      {
        id: "m1",
        from: { application: { displayName: "BotApp" } },
        body: { content: "automated msg", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("BotApp: automated msg");
  });

  it("skips messages with empty content", async () => {
    const { formatThreadContext } = await loadGraphThreadModule();
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "ok", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Bob: ok");
  });

  it("uses unknown sender fallback", async () => {
    const { formatThreadContext } = await loadGraphThreadModule();
    const messages = [{ id: "m1", body: { content: "hello", contentType: "text" } }];
    expect(formatThreadContext(messages)).toBe("unknown: hello");
  });
});
