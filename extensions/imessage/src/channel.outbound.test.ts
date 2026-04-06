import { describe, expect, it, vi } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { imessagePlugin } from "./channel.js";
import type { IMessageRpcClient } from "./client.js";
import { imessageOutbound } from "./outbound-adapter.js";
import { sendMessageIMessage } from "./send.js";

function requireIMessageChunker() {
  const chunker = imessagePlugin.outbound?.chunker;
  if (!chunker) {
    throw new Error("imessage outbound.chunker unavailable");
  }
  return chunker;
}

const requestMock = vi.fn();
const stopMock = vi.fn();

const defaultAccount: ResolvedIMessageAccount = {
  accountId: "default",
  enabled: true,
  configured: false,
  config: {},
};

function createClient(): IMessageRpcClient {
  return {
    request: (...args: unknown[]) => requestMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
  } as unknown as IMessageRpcClient;
}

async function sendWithDefaults(
  to: string,
  text: string,
  opts: Parameters<typeof sendMessageIMessage>[2] = {},
) {
  return await sendMessageIMessage(to, text, {
    account: defaultAccount,
    config: {},
    client: createClient(),
    ...opts,
  });
}

function getSentParams() {
  return requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
}

async function expectReplyToTextForwarding(params: {
  invoke: () => Promise<{ channel: string; messageId: string }>;
  sendIMessage: ReturnType<typeof vi.fn>;
}) {
  const result = await params.invoke();
  expect(params.sendIMessage).toHaveBeenCalledWith(
    "chat_id:12",
    "hello",
    expect.objectContaining({
      accountId: "default",
      replyToId: "reply-1",
      maxBytes: 3 * 1024 * 1024,
    }),
  );
  expect(result).toEqual({ channel: "imessage", messageId: "m-text" });
}

async function expectMediaLocalRootsForwarding(params: {
  invoke: () => Promise<{ channel: string; messageId: string }>;
  sendIMessage: ReturnType<typeof vi.fn>;
}) {
  const result = await params.invoke();
  expect(params.sendIMessage).toHaveBeenCalledWith(
    "chat_id:88",
    "caption",
    expect.objectContaining({
      mediaUrl: "/tmp/workspace/pic.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "acct-1",
      replyToId: "reply-2",
      maxBytes: 3 * 1024 * 1024,
    }),
  );
  expect(result).toEqual({ channel: "imessage", messageId: "m-media-local" });
}

describe("imessagePlugin outbound", () => {
  it("chunks outbound text without requiring iMessage runtime initialization", () => {
    const chunker = requireIMessageChunker();

    expect(() => chunker("hello world", 5)).not.toThrow();
    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });
});

describe("imessageOutbound", () => {
  const cfg = {
    channels: {
      imessage: {
        mediaMaxMb: 3,
      },
    },
  };

  it("forwards replyToId on direct text sends", async () => {
    const sendIMessage = vi.fn().mockResolvedValueOnce({ messageId: "m-text" });

    await expectReplyToTextForwarding({
      invoke: async () =>
        await imessageOutbound.sendText!({
          cfg,
          to: "chat_id:12",
          text: "hello",
          accountId: "default",
          replyToId: "reply-1",
          deps: { sendIMessage },
        }),
      sendIMessage,
    });
  });

  it("forwards mediaLocalRoots on direct media sends", async () => {
    const sendIMessage = vi.fn().mockResolvedValueOnce({ messageId: "m-media-local" });

    await expectMediaLocalRootsForwarding({
      invoke: async () =>
        await imessageOutbound.sendMedia!({
          cfg,
          to: "chat_id:88",
          text: "caption",
          mediaUrl: "/tmp/workspace/pic.png",
          mediaLocalRoots: ["/tmp/workspace"],
          accountId: "acct-1",
          replyToId: "reply-2",
          deps: { sendIMessage },
        }),
      sendIMessage,
    });
  });
});

describe("sendMessageIMessage", () => {
  it("sends to chat_id targets", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hi");
    const params = getSentParams();
    expect(requestMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    expect(params.chat_id).toBe(123);
    expect(params.text).toBe("hi");
  });
});
