// Msteams tests cover graph thread plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadContext,
  fetchChannelMessage,
  fetchChatMessageText,
  fetchThreadReplies,
  stripHtmlFromTeamsMessage,
} from "./graph-thread.js";
import { fetchGraphJson } from "./graph.js";

vi.mock("./graph.js", () => ({
  fetchGraphJson: vi.fn(),
}));

describe("stripHtmlFromTeamsMessage", () => {
  it("handles <at> tags with attributes", () => {
    expect(stripHtmlFromTeamsMessage('<at id="123">Bob</at> please review')).toBe(
      "@Bob please review",
    );
  });
});

describe("fetchChannelMessage", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("returns undefined on fetch error", async () => {
    vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("forbidden"));

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");
    expect(result).toBeUndefined();
  });
});

describe("fetchChatMessageText", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("fetches the chat message and strips HTML body to plain text", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      id: "1783379480258",
      body: {
        content: "<p>San Francisco right now: <at>Bot</at> &amp;lt;APIKEY&amp;gt;</p>",
        contentType: "html",
      },
    });

    const result = await fetchChatMessageText("tok", "19:chat@thread.v2", "1783379480258");

    expect(result).toBe("San Francisco right now: @Bot &lt;APIKEY&gt;");
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/chats/19%3Achat%40thread.v2/messages/1783379480258",
    });
  });

  it("returns undefined on fetch error", async () => {
    vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("not found"));

    const result = await fetchChatMessageText("tok", "19:chat", "m-1");
    expect(result).toBeUndefined();
  });

  it("forwards a shared deadline to the Graph request", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({});
    const deadline = {
      label: "MS Teams inbound preprocessing",
      timeoutMs: 10_000,
      deadlineAtMs: Date.now() + 10_000,
    };

    await fetchChatMessageText("tok", "19:chat", "m-1", deadline);

    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/chats/19%3Achat/messages/m-1",
      deadline,
    });
  });
});

describe("fetchThreadReplies", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("returns empty array when value is missing", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({});

    const result = await fetchThreadReplies("tok", "g", "c", "m");
    expect(result).toStrictEqual([]);
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g/channels/c/messages/m/replies?$top=50",
    });
  });
});

describe("buildThreadContext", () => {
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
    expect(buildThreadContext(messages, "m2")).toEqual([
      { message_id: "m1", sender: "Alice", body: "Hello!" },
    ]);
  });

  it("strips HTML from html contentType messages", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Carol" } },
        body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
      },
    ];
    expect(buildThreadContext(messages)).toEqual([
      { message_id: "m1", sender: "Carol", body: "Hello world" },
    ]);
  });

  it("uses application displayName when user is absent", () => {
    const messages = [
      {
        id: "m1",
        from: { application: { displayName: "BotApp" } },
        body: { content: "automated msg", contentType: "text" },
      },
    ];
    expect(buildThreadContext(messages)).toEqual([
      { message_id: "m1", sender: "BotApp", body: "automated msg" },
    ]);
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
    expect(buildThreadContext(messages)).toEqual([
      { message_id: "m2", sender: "Bob", body: "actual content" },
    ]);
  });

  it("falls back to 'unknown' sender when from is missing", () => {
    const messages = [
      {
        id: "m1",
        body: { content: "orphan msg", contentType: "text" },
      },
    ];
    expect(buildThreadContext(messages)).toEqual([
      { message_id: "m1", sender: "unknown", body: "orphan msg" },
    ]);
  });
});
