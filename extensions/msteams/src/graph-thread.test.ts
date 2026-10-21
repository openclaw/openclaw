import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadContext,
  fetchChannelMessage,
  fetchChatMessageText,
  fetchThreadReplies,
  stripHtmlFromTeamsMessage,
  type GraphThreadMessage,
} from "./graph-thread.js";
import type * as Graph from "./graph.js";
import { fetchGraphJson } from "./graph.js";

const fetchAllGraphPagesMock = vi.hoisted(() => vi.fn());
const message = (
  id: string,
  content: string,
  from: GraphThreadMessage["from"],
  contentType = "text",
): GraphThreadMessage => ({ id, from, body: { content, contentType } });

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Graph>()),
  fetchGraphJson: vi.fn(),
  fetchAllGraphPages: fetchAllGraphPagesMock,
}));

beforeEach(() => {
  vi.mocked(fetchGraphJson).mockReset();
  fetchAllGraphPagesMock.mockReset();
});

it("handles <at> tags with attributes", () => {
  expect(stripHtmlFromTeamsMessage('<at id="123">Bob</at> please review')).toBe(
    "@Bob please review",
  );
});

it.each([
  ["channel", () => fetchChannelMessage("tok", "group-1", "channel-1", "msg-1")],
  ["chat", () => fetchChatMessageText("tok", "19:chat", "m-1")],
] as const)("%s returns undefined on fetch error", async (_kind, fetchMessage) => {
  vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("forbidden"));
  await expect(fetchMessage()).resolves.toBeUndefined();
});

describe("fetchChatMessageText", () => {
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
  it("rejects a page-capped result instead of returning an old prefix", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: [{ id: "old-reply" }],
      truncated: true,
    });

    await expect(fetchThreadReplies("tok", "g", "c", "m")).rejects.toThrow(
      "MS Teams thread replies pagination did not reach the newest replies",
    );
  });

  it("rejects an incomplete timestamp set when selecting a newest window", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: Array.from({ length: 51 }, (_, index) => ({ id: `reply-${index}` })),
      truncated: false,
    });

    await expect(fetchThreadReplies("tok", "g", "c", "m")).rejects.toThrow(
      "MS Teams thread replies have incomplete timestamps",
    );
  });
});

describe("buildThreadContext", () => {
  it.each<[string, GraphThreadMessage[], ReturnType<typeof buildThreadContext>[number], string?]>([
    [
      "skips the current message by id",
      [
        message("m1", "Hello!", { user: { displayName: "Alice" } }),
        message("m2", "Current", { user: { displayName: "Bob" } }),
      ],
      { message_id: "m1", sender: "Alice", body: "Hello!" },
      "m2",
    ],
    [
      "strips HTML",
      [message("m1", "<p>Hello <b>world</b></p>", { user: { displayName: "Carol" } }, "html")],
      { message_id: "m1", sender: "Carol", body: "Hello world" },
    ],
    [
      "uses application displayName when user is absent",
      [message("m1", "automated msg", { application: { displayName: "BotApp" } })],
      { message_id: "m1", sender: "BotApp", body: "automated msg" },
    ],
    [
      "skips messages with empty content",
      [
        message("m1", "", { user: { displayName: "Alice" } }),
        message("m2", "actual content", { user: { displayName: "Bob" } }),
      ],
      { message_id: "m2", sender: "Bob", body: "actual content" },
    ],
    [
      "falls back to unknown sender when from is missing",
      [message("m1", "orphan msg", undefined)],
      { message_id: "m1", sender: "unknown", body: "orphan msg" },
    ],
  ])("%s", (_name, messages, expected, currentId) => {
    expect(buildThreadContext(messages, currentId)).toEqual([expected]);
  });
});
