import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "openclaw/plugin-sdk/matrix";
import { describe, expect, it, vi } from "vitest";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

const sendTypingMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../send.js", () => ({
  reactMatrixMessage: vi.fn().mockResolvedValue(undefined),
  sendMessageMatrix: vi.fn().mockResolvedValue({ messageId: "$unused" }),
  sendTypingMatrix: (...args: unknown[]) => sendTypingMatrixMock(...args),
}));

describe("createMatrixRoomMessageHandler typing flow", () => {
  it("wires Matrix typing start and stop callbacks into the reply dispatcher", async () => {
    const callOrder: string[] = [];
    let capturedTypingCallbacks:
      | {
          onReplyStart: () => Promise<void>;
          onIdle?: () => void;
        }
      | undefined;

    sendTypingMatrixMock.mockImplementation(async (_roomId, typing) => {
      callOrder.push(typing ? "typing-start" : "typing-stop");
      return undefined;
    });

    const createReplyDispatcherWithTypingStub = vi.fn().mockImplementation((options: unknown) => {
      const typed = options as {
        typingCallbacks?: {
          onReplyStart: () => Promise<void>;
          onIdle?: () => void;
        };
      };
      capturedTypingCallbacks = typed.typingCallbacks;
      throw new Error("capture-typing-callbacks");
    });

    const core = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
          upsertPairingRequest: vi.fn().mockResolvedValue(undefined),
        },
        routing: {
          buildAgentSessionKey: vi
            .fn()
            .mockImplementation(
              (params: { agentId: string; channel: string; peer?: { kind: string; id: string } }) =>
                `agent:${params.agentId}:${params.channel}:${params.peer?.kind ?? "direct"}:${params.peer?.id ?? "unknown"}`,
            ),
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: undefined,
            sessionKey: "agent:main:matrix:channel:!room:example.org",
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
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingStub,
        },
        commands: {
          shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
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

    const runtimeError = vi.fn();
    const runtime = {
      error: runtimeError,
      log: vi.fn(),
    } as unknown as RuntimeEnv;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as RuntimeLogger;
    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
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
      threadReplies: "inbound",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      startupMs: Date.now(),
      startupGraceMs: 60_000,
      directTracker: {
        isDirectMessage: vi.fn().mockResolvedValue(false),
      },
      getRoomInfo: vi.fn().mockResolvedValue({
        name: "Dev Room",
        canonicalAlias: "#dev:matrix.example.org",
        altAliases: [],
      }),
      getMemberDisplayName: vi.fn().mockResolvedValue("Bu"),
      accountId: undefined,
    });

    const event = {
      type: EventType.RoomMessage,
      event_id: "$inbound-1",
      sender: "@bu:matrix.example.org",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "show me my commits",
        "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$thread-root",
        },
      },
    } as unknown as MatrixRawEvent;

    await handler("!room:example", event);

    expect(createReplyDispatcherWithTypingStub).toHaveBeenCalledTimes(1);
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("matrix handler failed: Error: capture-typing-callbacks"),
    );
    expect(capturedTypingCallbacks).toBeDefined();

    await capturedTypingCallbacks?.onReplyStart();
    capturedTypingCallbacks?.onIdle?.();

    expect(sendTypingMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendTypingMatrixMock).toHaveBeenNthCalledWith(
      1,
      "!room:example",
      true,
      undefined,
      client,
    );
    expect(sendTypingMatrixMock).toHaveBeenNthCalledWith(
      2,
      "!room:example",
      false,
      undefined,
      client,
    );
    expect(callOrder).toEqual(["typing-start", "typing-stop"]);
  });
});
