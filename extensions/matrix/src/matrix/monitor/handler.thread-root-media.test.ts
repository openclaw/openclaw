import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "openclaw/plugin-sdk/matrix";
import { describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler thread root media", () => {
  it("keeps image-only thread roots visible via attachment markers", async () => {
    setMatrixRuntime({
      channel: {
        mentions: {
          matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
            patterns.some((pattern) => pattern.test(text)),
        },
        media: {
          saveMediaBuffer: vi.fn(),
        },
      },
      config: {
        loadConfig: () => ({}),
      },
      state: {
        resolveStateDir: () => "/tmp",
      },
    } as unknown as PluginRuntime);

    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const formatAgentEnvelope = vi
      .fn()
      .mockImplementation((params: { body: string }) => params.body);

    const core = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
          upsertPairingRequest: vi.fn().mockResolvedValue(undefined),
          buildPairingReply: vi.fn().mockReturnValue("pairing"),
        },
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: undefined,
            sessionKey: "agent:main:matrix:channel:!room:example.org",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope,
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          createReplyDispatcherWithTyping: vi.fn().mockReturnValue({
            dispatcher: {},
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          }),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          dispatchReplyFromConfig: vi
            .fn()
            .mockResolvedValue({ queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } }),
        },
        commands: {
          shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
        },
        reactions: {
          shouldAckReaction: vi.fn().mockReturnValue(false),
        },
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
    } as unknown as PluginRuntime;

    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
      getEvent: vi.fn().mockResolvedValue({
        event_id: "$thread-root",
        sender: "@gum:matrix.example.org",
        type: "m.room.message",
        origin_server_ts: 123,
        content: {
          msgtype: "m.image",
          body: "photo.jpg",
        },
      }),
    } as unknown as MatrixClient;

    const handler = createMatrixRoomMessageHandler({
      client,
      core,
      cfg: {},
      accountId: "ops",
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RuntimeLogger,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      groupAllowFrom: [],
      roomsConfig: undefined,
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "first",
      threadReplies: "inbound",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      startupMs: Date.now() - 120_000,
      startupGraceMs: 60_000,
      dropPreStartupMessages: false,
      directTracker: {
        isDirectMessage: vi.fn().mockResolvedValue(true),
      },
      dropPreStartupMessages: true,
      getRoomInfo: vi.fn().mockResolvedValue({
        name: "Media Room",
        canonicalAlias: "#media:example.org",
        altAliases: [],
      }),
      getMemberDisplayName: vi.fn().mockResolvedValue("Gum"),
      needsRoomAliasesForConfig: false,
    });

    await handler("!room:example.org", {
      type: EventType.RoomMessage,
      event_id: "$reply",
      sender: "@bu:matrix.example.org",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "replying",
        "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$thread-root",
        },
      },
    } as MatrixRawEvent);

    expect(formatAgentEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("replying"),
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          ThreadStarterBody: expect.stringContaining("[matrix image attachment]"),
        }),
      }),
    );
  });
});
