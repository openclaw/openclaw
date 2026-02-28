import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "openclaw/plugin-sdk";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());
const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageMatrix: (...args: unknown[]) => sendMessageMatrixMock(...args),
  sendTypingMatrix: vi.fn().mockResolvedValue(undefined),
  reactMatrixMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: (...args: unknown[]) => deliverMatrixRepliesMock(...args),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler reasoning stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMatrixMock.mockResolvedValue({ messageId: "$reason-root", roomId: "!room:example" });
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
                sendToolResult: vi.fn(),
                sendBlockReply: vi.fn(),
                sendFinalReply: vi.fn(),
              },
              replyOptions: {},
              markDispatchIdle,
            };
          }),
          withReplyDispatcher: vi.fn().mockImplementation(
            async (params: {
              run: () => Promise<{
                queuedFinal: boolean;
                counts: { final: number; block: number; tool: number };
              }>;
              onSettled?: () => void | Promise<void>;
            }) => {
              const result = await params.run();
              await params.onSettled?.();
              return result;
            },
          ),
          dispatchReplyFromConfig: vi.fn().mockImplementation(
            async (params: {
              replyOptions?: {
                onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
              };
            }) => {
              await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 1" });
              await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\nstep 2" });
              await deliverFromDispatcher?.({ text: "Final answer" }, { kind: "final" });
              return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
            },
          ),
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

    sendMessageMatrixMock.mockImplementation(async () => {
      callOrder.push("send-reasoning");
      return { messageId: "$reason-root", roomId: "!room:example" };
    });
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

    const clientSendMessage = vi.fn().mockImplementation(async () => {
      callOrder.push("edit-reasoning");
      return "$reason-edit";
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

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(clientSendMessage).toHaveBeenCalledTimes(1);
    expect(clientRedactEvent).toHaveBeenCalledTimes(1);
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "send-reasoning",
      "edit-reasoning",
      "delete-reasoning",
      "deliver-final",
    ]);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
  });
});
