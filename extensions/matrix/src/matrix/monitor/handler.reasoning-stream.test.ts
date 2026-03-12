import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "openclaw/plugin-sdk";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: () => undefined,
  getOAuthProviders: () => [],
}));

const dispatchReplyFromConfigWithSettledDispatcherMock = vi.hoisted(() => vi.fn());
const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn());
const enqueueSendMock = vi.hoisted(() =>
  vi.fn(async (_roomId: string, fn: () => Promise<unknown>) => await fn()),
);

vi.mock("openclaw/plugin-sdk/matrix", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/matrix")>(
    "openclaw/plugin-sdk/matrix",
  );
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher: (...args: unknown[]) =>
      dispatchReplyFromConfigWithSettledDispatcherMock(...args),
  };
});

vi.mock("../send.js", () => ({
  sendMessageMatrix: vi.fn(),
  sendTypingMatrix: vi.fn().mockResolvedValue(undefined),
  reactMatrixMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../send-queue.js", () => ({
  enqueueSend: (roomId: string, fn: () => Promise<unknown>) => enqueueSendMock(roomId, fn),
}));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: (...args: unknown[]) => deliverMatrixRepliesMock(...args),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler reasoning stream", () => {
  let finalDeliveryPromise: Promise<void> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    finalDeliveryPromise = undefined;
    enqueueSendMock.mockImplementation(
      async (_roomId: string, fn: () => Promise<unknown>) => await fn(),
    );
    dispatchReplyFromConfigWithSettledDispatcherMock.mockImplementation(
      async (params: {
        dispatcher: { sendFinalReply: (payload: ReplyPayload) => boolean };
        onSettled?: () => void | Promise<void>;
        replyOptions?: {
          onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
        };
      }) => {
        await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 1" });
        await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 2" });
        params.dispatcher.sendFinalReply({ text: "Final answer" });
        await finalDeliveryPromise;
        await params.onSettled?.();
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      },
    );
    deliverMatrixRepliesMock.mockResolvedValue(undefined);
  });

  it("streams reasoning into one transient bubble, then deletes it before final reply", async () => {
    const callOrder: string[] = [];
    const markDispatchIdle = vi.fn();
    let deliverFromDispatcher:
      | ((payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;

    const core = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
        },
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: undefined,
            sessionKey: "agent:main:matrix:user:@alice:example.org",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(123),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatInboundEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          formatAgentEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          createReplyDispatcherWithTyping: vi.fn().mockImplementation((options: unknown) => {
            const typed = options as {
              deliver: (
                payload: ReplyPayload,
                info: { kind: "tool" | "block" | "final" },
              ) => Promise<void>;
            };
            deliverFromDispatcher = typed.deliver;
            return {
              dispatcher: {
                getQueuedCounts: vi.fn(() => ({ final: 0, block: 0, tool: 0 })),
                markComplete: vi.fn(),
                sendToolResult: vi.fn(),
                sendBlockReply: vi.fn(),
                sendFinalReply: vi.fn((payload: ReplyPayload) => {
                  finalDeliveryPromise = deliverFromDispatcher?.(payload, { kind: "final" });
                  return true;
                }),
                waitForIdle: vi.fn().mockResolvedValue(undefined),
              },
              replyOptions: {},
              markDispatchIdle,
            };
          }),
        },
        commands: {
          shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          resolveChunkMode: vi.fn().mockReturnValue("length"),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
        mentions: {
          buildMentionRegexes: vi.fn().mockReturnValue([]),
          detectDirectMentionFromRegexes: vi.fn().mockReturnValue(false),
          detectBotMentionFromRegexes: vi.fn().mockReturnValue(false),
          matchesMentionPatterns: vi.fn().mockReturnValue(false),
        },
        reactions: {
          shouldAckReaction: vi.fn().mockReturnValue(false),
        },
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      logging: {
        shouldLogVerbose: vi.fn().mockReturnValue(false),
      },
      config: {
        loadConfig: vi.fn().mockReturnValue({}),
      },
    } as unknown as PluginRuntime;
    setMatrixRuntime(core);

    deliverMatrixRepliesMock.mockImplementation(async () => {
      callOrder.push("deliver-final");
      return undefined;
    });

    const runtimeError = vi.fn();
    const runtime = {
      error: runtimeError,
      log: vi.fn(),
    } as unknown as RuntimeEnv;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as RuntimeLogger;

    const clientSendMessage = vi.fn().mockImplementation(async (_roomId, content) => {
      if (content && typeof content === "object" && "m.new_content" in content) {
        callOrder.push("edit-reasoning");
        return "$reason-edit";
      }
      callOrder.push("send-reasoning");
      return "$reason-root";
    });
    const clientRedactEvent = vi.fn().mockImplementation(async () => {
      callOrder.push("delete-reasoning");
      return undefined;
    });

    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
      sendMessage: clientSendMessage,
      redactEvent: clientRedactEvent,
    } as unknown as MatrixClient;

    const handler = createMatrixRoomMessageHandler({
      client,
      core,
      cfg: {},
      runtime,
      logger,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      roomsConfig: undefined,
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "first",
      threadReplies: "off",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      startupMs: Date.now(),
      startupGraceMs: 60_000,
      directTracker: {
        isDirectMessage: vi.fn().mockResolvedValue(true),
      },
      getRoomInfo: vi.fn().mockResolvedValue({
        name: "DM",
        canonicalAlias: undefined,
        altAliases: [],
      }),
      getMemberDisplayName: vi.fn().mockResolvedValue("Alice"),
      accountId: undefined,
    });

    const event = {
      type: EventType.RoomMessage,
      event_id: "$inbound-1",
      sender: "@alice:example.org",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    } as unknown as MatrixRawEvent;

    await handler("!room:example", event);

    expect(runtimeError).not.toHaveBeenCalled();

    expect(clientSendMessage).toHaveBeenCalledTimes(2);
    expect(clientRedactEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSendMock).toHaveBeenCalledTimes(3);
    expect(enqueueSendMock).toHaveBeenNthCalledWith(1, "!room:example", expect.any(Function));
    expect(enqueueSendMock).toHaveBeenNthCalledWith(2, "!room:example", expect.any(Function));
    expect(enqueueSendMock).toHaveBeenNthCalledWith(3, "!room:example", expect.any(Function));
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "send-reasoning",
      "edit-reasoning",
      "delete-reasoning",
      "deliver-final",
    ]);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("drops stale queued reasoning edits before delivering the final reply", async () => {
    const callOrder: string[] = [];
    const markDispatchIdle = vi.fn();
    let deliverFromDispatcher:
      | ((payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;
    let resolveBlockedEdit: ((value: string) => void) | undefined;

    dispatchReplyFromConfigWithSettledDispatcherMock.mockImplementationOnce(
      async (params: {
        dispatcher: { sendFinalReply: (payload: ReplyPayload) => boolean };
        onSettled?: () => void | Promise<void>;
        replyOptions?: {
          onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
        };
      }) => {
        await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 1" });
        const queuedEdit = params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 2" });
        const staleQueuedEdit = params.replyOptions?.onReasoningStream?.({
          text: "Reasoning:\nstep 3",
        });
        params.dispatcher.sendFinalReply({ text: "Final answer" });
        resolveBlockedEdit?.("$reason-edit");
        await Promise.allSettled([queuedEdit, staleQueuedEdit, finalDeliveryPromise]);
        await params.onSettled?.();
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      },
    );

    const core = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
        },
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: undefined,
            sessionKey: "agent:main:matrix:user:@alice:example.org",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(123),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatInboundEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          formatAgentEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          createReplyDispatcherWithTyping: vi.fn().mockImplementation((options: unknown) => {
            const typed = options as {
              deliver: (
                payload: ReplyPayload,
                info: { kind: "tool" | "block" | "final" },
              ) => Promise<void>;
            };
            deliverFromDispatcher = typed.deliver;
            return {
              dispatcher: {
                getQueuedCounts: vi.fn(() => ({ final: 0, block: 0, tool: 0 })),
                markComplete: vi.fn(),
                sendToolResult: vi.fn(),
                sendBlockReply: vi.fn(),
                sendFinalReply: vi.fn((payload: ReplyPayload) => {
                  finalDeliveryPromise = deliverFromDispatcher?.(payload, { kind: "final" });
                  return true;
                }),
                waitForIdle: vi.fn().mockResolvedValue(undefined),
              },
              replyOptions: {},
              markDispatchIdle,
            };
          }),
        },
        commands: {
          shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          resolveChunkMode: vi.fn().mockReturnValue("length"),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
        mentions: {
          buildMentionRegexes: vi.fn().mockReturnValue([]),
          detectDirectMentionFromRegexes: vi.fn().mockReturnValue(false),
          detectBotMentionFromRegexes: vi.fn().mockReturnValue(false),
          matchesMentionPatterns: vi.fn().mockReturnValue(false),
        },
        reactions: {
          shouldAckReaction: vi.fn().mockReturnValue(false),
        },
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      logging: {
        shouldLogVerbose: vi.fn().mockReturnValue(false),
      },
      config: {
        loadConfig: vi.fn().mockReturnValue({}),
      },
    } as unknown as PluginRuntime;
    setMatrixRuntime(core);

    deliverMatrixRepliesMock.mockImplementation(async () => {
      callOrder.push("deliver-final");
      return undefined;
    });

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
    } as unknown as RuntimeEnv;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as RuntimeLogger;

    const blockedEdit = new Promise<string>((resolve) => {
      resolveBlockedEdit = resolve;
    });
    const clientSendMessage = vi.fn().mockImplementation(async (_roomId, content) => {
      if (content && typeof content === "object" && "m.new_content" in content) {
        callOrder.push(`edit:${String(content["m.new_content"].body)}`);
        return await blockedEdit;
      }
      callOrder.push("send-reasoning");
      return "$reason-root";
    });
    const clientRedactEvent = vi.fn().mockImplementation(async () => {
      callOrder.push("delete-reasoning");
      return undefined;
    });

    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
      sendMessage: clientSendMessage,
      redactEvent: clientRedactEvent,
    } as unknown as MatrixClient;

    const handler = createMatrixRoomMessageHandler({
      client,
      core,
      cfg: {},
      runtime,
      logger,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      roomsConfig: undefined,
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "first",
      threadReplies: "off",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      startupMs: Date.now(),
      startupGraceMs: 60_000,
      directTracker: {
        isDirectMessage: vi.fn().mockResolvedValue(true),
      },
      getRoomInfo: vi.fn().mockResolvedValue({
        name: "DM",
        canonicalAlias: undefined,
        altAliases: [],
      }),
      getMemberDisplayName: vi.fn().mockResolvedValue("Alice"),
      accountId: undefined,
    });

    const event = {
      type: EventType.RoomMessage,
      event_id: "$inbound-1",
      sender: "@alice:example.org",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    } as unknown as MatrixRawEvent;

    await handler("!room:example", event);

    expect(clientSendMessage).toHaveBeenCalledTimes(2);
    expect(clientRedactEvent).toHaveBeenCalledTimes(1);
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "send-reasoning",
      "edit:Reasoning:\nstep 2",
      "delete-reasoning",
      "deliver-final",
    ]);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("retries reasoning draft cleanup on settle when the first redact fails", async () => {
    const markDispatchIdle = vi.fn();
    let deliverFromDispatcher:
      | ((payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;

    const core = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
        },
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: undefined,
            sessionKey: "agent:main:matrix:user:@alice:example.org",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(123),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatInboundEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          formatAgentEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          createReplyDispatcherWithTyping: vi.fn().mockImplementation((options: unknown) => {
            const typed = options as {
              deliver: (
                payload: ReplyPayload,
                info: { kind: "tool" | "block" | "final" },
              ) => Promise<void>;
            };
            deliverFromDispatcher = typed.deliver;
            return {
              dispatcher: {
                getQueuedCounts: vi.fn(() => ({ final: 0, block: 0, tool: 0 })),
                markComplete: vi.fn(),
                sendToolResult: vi.fn(),
                sendBlockReply: vi.fn(),
                sendFinalReply: vi.fn((payload: ReplyPayload) => {
                  finalDeliveryPromise = deliverFromDispatcher?.(payload, { kind: "final" });
                  return true;
                }),
                waitForIdle: vi.fn().mockResolvedValue(undefined),
              },
              replyOptions: {},
              markDispatchIdle,
            };
          }),
        },
        commands: {
          shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          resolveChunkMode: vi.fn().mockReturnValue("length"),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
        mentions: {
          buildMentionRegexes: vi.fn().mockReturnValue([]),
          detectDirectMentionFromRegexes: vi.fn().mockReturnValue(false),
          detectBotMentionFromRegexes: vi.fn().mockReturnValue(false),
          matchesMentionPatterns: vi.fn().mockReturnValue(false),
        },
        reactions: {
          shouldAckReaction: vi.fn().mockReturnValue(false),
        },
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      logging: {
        shouldLogVerbose: vi.fn().mockReturnValue(false),
      },
      config: {
        loadConfig: vi.fn().mockReturnValue({}),
      },
    } as unknown as PluginRuntime;
    setMatrixRuntime(core);

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
    } as unknown as RuntimeEnv;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as RuntimeLogger;

    const clientSendMessage = vi
      .fn()
      .mockResolvedValueOnce("$reason-root")
      .mockResolvedValueOnce("$reason-edit");
    const clientRedactEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient redact failure"))
      .mockResolvedValueOnce(undefined);

    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
      sendMessage: clientSendMessage,
      redactEvent: clientRedactEvent,
    } as unknown as MatrixClient;

    const handler = createMatrixRoomMessageHandler({
      client,
      core,
      cfg: {},
      runtime,
      logger,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      roomsConfig: undefined,
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "first",
      threadReplies: "off",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      startupMs: Date.now(),
      startupGraceMs: 60_000,
      directTracker: {
        isDirectMessage: vi.fn().mockResolvedValue(true),
      },
      getRoomInfo: vi.fn().mockResolvedValue({
        name: "DM",
        canonicalAlias: undefined,
        altAliases: [],
      }),
      getMemberDisplayName: vi.fn().mockResolvedValue("Alice"),
      accountId: undefined,
    });

    const event = {
      type: EventType.RoomMessage,
      event_id: "$inbound-1",
      sender: "@alice:example.org",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    } as unknown as MatrixRawEvent;

    await handler("!room:example", event);

    expect(clientRedactEvent).toHaveBeenCalledTimes(2);
    expect(enqueueSendMock).toHaveBeenCalledTimes(4);
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("still delivers the final reply when an in-flight reasoning edit fails", async () => {
    const markDispatchIdle = vi.fn();
    let deliverFromDispatcher:
      | ((payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;

    dispatchReplyFromConfigWithSettledDispatcherMock.mockImplementationOnce(
      async (params: {
        dispatcher: { sendFinalReply: (payload: ReplyPayload) => boolean };
        onSettled?: () => void | Promise<void>;
        replyOptions?: {
          onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
        };
      }) => {
        await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 1" });
        const failedEdit = params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 2" });
        await Promise.resolve();
        params.dispatcher.sendFinalReply({ text: "Final answer" });
        await finalDeliveryPromise;
        await params.onSettled?.();
        await Promise.allSettled([failedEdit]);
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      },
    );

    const core = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
        },
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: undefined,
            sessionKey: "agent:main:matrix:user:@alice:example.org",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(123),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatInboundEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          formatAgentEnvelope: vi
            .fn()
            .mockImplementation((params: { body: string }) => params.body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          createReplyDispatcherWithTyping: vi.fn().mockImplementation((options: unknown) => {
            const typed = options as {
              deliver: (
                payload: ReplyPayload,
                info: { kind: "tool" | "block" | "final" },
              ) => Promise<void>;
            };
            deliverFromDispatcher = typed.deliver;
            return {
              dispatcher: {
                getQueuedCounts: vi.fn(() => ({ final: 0, block: 0, tool: 0 })),
                markComplete: vi.fn(),
                sendFinalReply: vi.fn((payload: ReplyPayload) => {
                  finalDeliveryPromise = typed.deliver(payload, { kind: "final" });
                  return true;
                }),
                waitForIdle: vi.fn().mockResolvedValue(undefined),
              },
              replyOptions: {},
              markDispatchIdle,
            };
          }),
        },
        commands: {
          shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          resolveChunkMode: vi.fn().mockReturnValue("length"),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
        mentions: {
          buildMentionRegexes: vi.fn().mockReturnValue([]),
          detectDirectMentionFromRegexes: vi.fn().mockReturnValue(false),
          detectBotMentionFromRegexes: vi.fn().mockReturnValue(false),
          matchesMentionPatterns: vi.fn().mockReturnValue(false),
        },
        reactions: {
          shouldAckReaction: vi.fn().mockReturnValue(false),
        },
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      logging: {
        shouldLogVerbose: vi.fn().mockReturnValue(false),
      },
      config: {
        loadConfig: vi.fn().mockReturnValue({}),
      },
    } as unknown as PluginRuntime;
    setMatrixRuntime(core);

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
    } as unknown as RuntimeEnv;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as RuntimeLogger;

    const callOrder: string[] = [];
    deliverMatrixRepliesMock.mockImplementation(async () => {
      callOrder.push("deliver-final");
      return undefined;
    });
    let sendCount = 0;
    const clientSendMessage = vi.fn().mockImplementation(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        callOrder.push("send-reasoning");
        return "$reason-root";
      }
      if (sendCount === 2) {
        callOrder.push("edit-reasoning");
        throw new Error("transient edit failure");
      }
      return "$unexpected";
    });
    const clientRedactEvent = vi.fn().mockImplementation(async () => {
      callOrder.push("delete-reasoning");
    });

    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
      sendMessage: clientSendMessage,
      redactEvent: clientRedactEvent,
    } as unknown as MatrixClient;

    const handler = createMatrixRoomMessageHandler({
      client,
      core,
      cfg: {},
      runtime,
      logger,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      roomsConfig: undefined,
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "first",
      threadReplies: "off",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      startupMs: Date.now(),
      startupGraceMs: 60_000,
      directTracker: {
        isDirectMessage: vi.fn().mockResolvedValue(true),
      },
      getRoomInfo: vi.fn().mockResolvedValue({
        name: "DM",
        canonicalAlias: undefined,
        altAliases: [],
      }),
      getMemberDisplayName: vi.fn().mockResolvedValue("Alice"),
      accountId: undefined,
    });

    const event = {
      type: EventType.RoomMessage,
      event_id: "$inbound-1",
      sender: "@alice:example.org",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    } as unknown as MatrixRawEvent;

    await handler("!room:example", event);

    expect(clientRedactEvent).toHaveBeenCalledTimes(1);
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "send-reasoning",
      "edit-reasoning",
      "delete-reasoning",
      "deliver-final",
    ]);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "matrix reasoning draft update failed: Error: transient edit failure",
      ),
    );
  });
});
