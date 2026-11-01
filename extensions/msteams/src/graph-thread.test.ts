import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadContext,
  fetchChannelMessage,
  fetchChatMessageText,
  fetchThreadReplies,
  type GraphThreadMessage,
} from "./graph-thread.js";
import type * as Graph from "./graph.js";
import { fetchGraphJson } from "./graph.js";

const fetchAllGraphPagesMock = vi.hoisted(() => vi.fn());
const msg = (id: string, body: string, sender?: string, html = false): GraphThreadMessage => ({
  id,
  from: sender ? { user: { displayName: sender } } : undefined,
  body: { content: body, contentType: html ? "html" : "text" },
});

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Graph>()),
  fetchGraphJson: vi.fn(),
  fetchAllGraphPages: fetchAllGraphPagesMock,
}));

beforeEach(() => {
  vi.mocked(fetchGraphJson).mockReset();
  fetchAllGraphPagesMock.mockReset();
});

it.each([
  ["channel", () => fetchChannelMessage("tok", "group-1", "channel-1", "msg-1")],
  ["chat", () => fetchChatMessageText("tok", "19:chat", "m-1")],
] as const)("%s returns undefined on fetch error", async (_kind, fetchMessage) => {
  vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("forbidden"));
  await expect(fetchMessage()).resolves.toBeUndefined();
});

describe("fetchChatMessageText", () => {
  it("returns undefined when a successful message has no body", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({});
    await expect(fetchChatMessageText("tok", "19:chat", "m-1")).resolves.toBeUndefined();
  });

  it("fetches the chat message and strips HTML body to plain text", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      id: "1783379480258",
      body: {
        content: '<p>San Francisco right now: <at id="123">Bot</at> &amp;lt;APIKEY&amp;gt;</p>',
        contentType: "html",
      },
    });

    const deadline = {
      label: "MS Teams inbound preprocessing",
      timeoutMs: 10_000,
      deadlineAtMs: Date.now() + 10_000,
    };

    await expect(
      fetchChatMessageText("tok", "19:chat@thread.v2", "1783379480258", deadline),
    ).resolves.toBe("San Francisco right now: @Bot &lt;APIKEY&gt;");
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/chats/19%3Achat%40thread.v2/messages/1783379480258",
      deadline,
    });
  });
});

describe("fetchThreadReplies", () => {
  it.each([
    [true, [{ id: "old-reply" }], "pagination did not reach the newest replies"],
    [
      false,
      Array.from({ length: 51 }, (_, i) => ({ id: `reply-${i}` })),
      "have incomplete timestamps",
    ],
  ])("rejects incomplete reply windows (truncated=%s)", async (truncated, items, error) => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({ items, truncated });
    await expect(fetchThreadReplies("tok", "g", "c", "m")).rejects.toThrow(
      `MS Teams thread replies ${error}`,
    );
  });
});

describe("buildThreadContext", () => {
  it.each<[string, GraphThreadMessage[], string, string, string, string?]>([
    ["current message", [msg("1", "Hi", "A"), msg("2", "Now", "B")], "1", "A", "Hi", "2"],
    ["HTML", [msg("1", "<p>Hello <b>world</b></p>", "A", true)], "1", "A", "Hello world"],
    [
      "application",
      [{ ...msg("1", "Hi"), from: { application: { displayName: "Bot" } } }],
      "1",
      "Bot",
      "Hi",
    ],
    ["empty content", [msg("1", "", "A"), msg("2", "Hi", "B")], "2", "B", "Hi"],
    ["missing sender", [msg("1", "Hi")], "1", "unknown", "Hi"],
  ])("handles %s", (_name, messages, message_id, sender, body, currentId) => {
    expect(buildThreadContext(messages, currentId)).toEqual([{ message_id, sender, body }]);
  });
});
