import { beforeEach, describe, expect, it, vi } from "vitest";

const emitMessageSent = vi.fn();

const sendMessageFeishu = vi.fn();
const sendMarkdownCardFeishu = vi.fn();
const editMessageFeishu = vi.fn();
const createCardEntityFeishu = vi.fn();
const sendCardByCardIdFeishu = vi.fn();
const updateCardElementContentFeishu = vi.fn();
const updateCardSummaryFeishu = vi.fn();
const closeStreamingModeFeishu = vi.fn();
const deleteMessageFeishu = vi.fn();

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    emitMessageSent: (...args: unknown[]) => emitMessageSent(...args),
    createReplyPrefixContext: () => ({
      responsePrefix: undefined,
      responsePrefixContextProvider: () => ({}),
      onModelSelected: () => {},
    }),
    createTypingCallbacks: () => ({
      onReplyStart: async () => {},
      onIdle: () => {},
      onCleanup: () => {},
    }),
    logTypingFailure: vi.fn(),
  };
});

vi.mock("./send.js", () => ({
  sendMessageFeishu: (...args: unknown[]) => sendMessageFeishu(...args),
  sendMarkdownCardFeishu: (...args: unknown[]) => sendMarkdownCardFeishu(...args),
  editMessageFeishu: (...args: unknown[]) => editMessageFeishu(...args),
  createCardEntityFeishu: (...args: unknown[]) => createCardEntityFeishu(...args),
  sendCardByCardIdFeishu: (...args: unknown[]) => sendCardByCardIdFeishu(...args),
  updateCardElementContentFeishu: (...args: unknown[]) => updateCardElementContentFeishu(...args),
  updateCardSummaryFeishu: (...args: unknown[]) => updateCardSummaryFeishu(...args),
  closeStreamingModeFeishu: (...args: unknown[]) => closeStreamingModeFeishu(...args),
  deleteMessageFeishu: (...args: unknown[]) => deleteMessageFeishu(...args),
}));

const { createFeishuReplyDispatcher } = await import("./reply-dispatcher.js");
const { setFeishuRuntime } = await import("./runtime.js");

function createRuntime(chunkTextWithModeImpl?: (text: string) => string[]) {
  const pending: Array<Promise<void>> = [];
  const chunkTextWithMode = chunkTextWithModeImpl ?? ((text: string) => [text]);

  return {
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
        resolveChunkMode: () => "text",
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
        chunkTextWithMode: (text: string) => chunkTextWithMode(text),
      },
      reply: {
        resolveHumanDelayConfig: () => ({ mode: "off" }),
        createReplyDispatcherWithTyping: (options: {
          deliver: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
          onCleanup?: () => void;
        }) => {
          const enqueue = (payload: { text?: string }, kind: "tool" | "block" | "final") => {
            const job = options.deliver(payload, { kind });
            pending.push(job);
          };

          return {
            dispatcher: {
              sendToolResult: (payload: { text?: string }) => {
                enqueue(payload, "tool");
                return true;
              },
              sendBlockReply: (payload: { text?: string }) => {
                enqueue(payload, "block");
                return true;
              },
              sendFinalReply: (payload: { text?: string }) => {
                enqueue(payload, "final");
                return true;
              },
              waitForIdle: async () => {
                await Promise.all(pending);
              },
              getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
              cleanup: () => {
                options.onCleanup?.();
              },
            },
            replyOptions: {},
            markDispatchIdle: () => {},
          };
        },
      },
    },
  };
}

beforeEach(() => {
  emitMessageSent.mockReset();
  sendMessageFeishu.mockReset();
  sendMarkdownCardFeishu.mockReset();
  editMessageFeishu.mockReset();
  createCardEntityFeishu.mockReset();
  sendCardByCardIdFeishu.mockReset();
  updateCardElementContentFeishu.mockReset();
  updateCardSummaryFeishu.mockReset();
  closeStreamingModeFeishu.mockReset();
  deleteMessageFeishu.mockReset();
});

describe("createFeishuReplyDispatcher message_sent hooks", () => {
  it("emits one message_sent with conversationId and first non-streaming messageId", async () => {
    setFeishuRuntime(createRuntime(() => ["part-1", "part-2"]) as never);
    sendMessageFeishu
      .mockResolvedValueOnce({ messageId: "om_first", chatId: "oc_chat" })
      .mockResolvedValueOnce({ messageId: "om_second", chatId: "oc_chat" });

    const { dispatcher } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "raw",
            streaming: false,
            blockStreaming: false,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
    });

    dispatcher.sendFinalReply({ text: "hello world" });
    await dispatcher.waitForIdle();

    expect(emitMessageSent).toHaveBeenCalledTimes(1);
    expect(emitMessageSent).toHaveBeenCalledWith(
      {
        to: "oc_chat",
        content: "hello world",
        success: true,
        messageId: "om_first",
      },
      {
        channelId: "feishu",
        accountId: "default",
        conversationId: "oc_chat",
      },
    );
  });

  it("does not emit message_sent when block streaming only updates existing card", async () => {
    setFeishuRuntime(createRuntime() as never);
    createCardEntityFeishu.mockResolvedValue({ cardId: "card_1" });
    sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_card", chatId: "oc_chat" });
    updateCardElementContentFeishu.mockResolvedValue(undefined);

    const { dispatcher } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "card",
            streaming: false,
            blockStreaming: true,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
    });

    dispatcher.sendBlockReply({ text: "first block" });
    await dispatcher.waitForIdle();
    dispatcher.sendBlockReply({ text: "second block" });
    await dispatcher.waitForIdle();

    expect(emitMessageSent).toHaveBeenCalledTimes(1);
    expect(emitMessageSent).toHaveBeenCalledWith(
      {
        to: "oc_chat",
        content: "first block",
        success: true,
        messageId: "om_card",
      },
      {
        channelId: "feishu",
        accountId: "default",
        conversationId: "oc_chat",
      },
    );
    expect(updateCardElementContentFeishu).toHaveBeenCalledTimes(1);
  });

  it("closes streaming mode only once when final delivery and cleanup race", async () => {
    setFeishuRuntime(createRuntime() as never);
    createCardEntityFeishu.mockResolvedValue({ cardId: "card_1" });
    sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_card", chatId: "oc_chat" });
    updateCardElementContentFeishu.mockResolvedValue(undefined);
    updateCardSummaryFeishu.mockResolvedValue(undefined);
    closeStreamingModeFeishu.mockResolvedValue(undefined);

    const { dispatcher, replyOptions } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "card",
            streaming: true,
            blockStreaming: false,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    await replyOptions.onModelSelected?.({} as never);

    dispatcher.sendFinalReply({ text: "final answer" });
    (dispatcher as unknown as { cleanup: () => void }).cleanup();
    await dispatcher.waitForIdle();

    expect(closeStreamingModeFeishu).toHaveBeenCalledTimes(1);
  });
});
