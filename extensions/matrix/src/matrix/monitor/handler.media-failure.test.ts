import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "../../../runtime-api.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", () => ({
  downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
}));

import { createMatrixRoomMessageHandler } from "./handler.js";

function createHandlerHarness() {
  const recordInboundSession = vi.fn().mockResolvedValue(undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeLogger;
  const runtime = {
    error: vi.fn(),
  } as unknown as RuntimeEnv;
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
      mentions: {
        buildMentionRegexes: vi.fn().mockReturnValue([]),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(123),
        recordInboundSession,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatAgentEnvelope: vi.fn().mockImplementation((params: { body: string }) => params.body),
        finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
        createReplyDispatcherWithTyping: vi.fn().mockReturnValue({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
          markRunComplete: vi.fn(),
        }),
        resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
        dispatchReplyFromConfig: vi
          .fn()
          .mockResolvedValue({ queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } }),
        withReplyDispatcher: vi.fn().mockImplementation(async ({ run, onSettled }) => {
          try {
            return await run();
          } finally {
            await onSettled?.();
          }
        }),
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
  } as unknown as MatrixClient;

  const handler = createMatrixRoomMessageHandler({
    client,
    core,
    cfg: {},
    accountId: "ops",
    runtime,
    logger,
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

  return { handler, recordInboundSession, logger, runtime };
}

function createImageEvent(content: Record<string, unknown>): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    event_id: "$event1",
    sender: "@gum:matrix.example.org",
    origin_server_ts: Date.now(),
    content: {
      ...content,
      "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
    },
  } as MatrixRawEvent;
}

describe("createMatrixRoomMessageHandler media failures", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("replaces bare image filenames with an unavailable marker when unencrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession, logger, runtime } = createHandlerHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "image.png",
        url: "mxc://example/image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          RawBody: "[matrix image attachment unavailable]",
          CommandBody: "[matrix image attachment unavailable]",
          MediaPath: undefined,
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix media download failed",
      expect.objectContaining({
        eventId: "$event1",
        msgtype: "m.image",
        encrypted: false,
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("replaces bare image filenames with an unavailable marker when encrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("decrypt failed"));
    const { handler, recordInboundSession } = createHandlerHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "photo.jpg",
        file: {
          url: "mxc://example/encrypted",
          key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          RawBody: "[matrix image attachment unavailable]",
          CommandBody: "[matrix image attachment unavailable]",
          MediaPath: undefined,
        }),
      }),
    );
  });

  it("preserves a real caption while marking the attachment unavailable", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession } = createHandlerHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "can you see this image?",
        filename: "image.png",
        url: "mxc://example/image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          RawBody: "can you see this image?\n\n[matrix image attachment unavailable]",
          CommandBody: "can you see this image?\n\n[matrix image attachment unavailable]",
        }),
      }),
    );
  });
});
