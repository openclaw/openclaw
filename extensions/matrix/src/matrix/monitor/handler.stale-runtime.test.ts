// Guards against the regression in issue #90325 where a stale @openclaw/matrix
// install (or otherwise incompatible plugin runtime) leaves
// `core.channel.inbound.run` undefined. The previous behavior failed only
// per-inbound-message with the generic
// `TypeError: Cannot read properties of undefined (reading 'run')`, silently
// dropping every Matrix message. The handler now refuses to construct and emits
// an actionable error pointing the user at the doctor/reinstall recovery path.
import { describe, expect, it } from "vitest";
import type { RuntimeEnv, RuntimeLogger } from "../../runtime-api.js";
import { createMatrixRoomMessageHandler, type MatrixMonitorHandlerParams } from "./handler.js";

function buildCoreWithoutInbound(): unknown {
  // Provide every other channel surface the matrix handler reads so the only
  // missing piece is `core.channel.inbound.run`, mirroring the production
  // failure mode (stale plugin import path).
  return {
    config: { current: () => ({}) },
    channel: {
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({ code: "X", created: false }),
        buildPairingReply: () => "",
      },
      commands: { shouldHandleTextCommands: () => false },
      text: {
        hasControlCommand: () => false,
        resolveMarkdownTableMode: () => "preserve",
      },
      routing: { resolveAgentRoute: () => undefined },
      mentions: { buildMentionRegexes: () => [] },
      session: {
        resolveStorePath: () => "/tmp/x",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (ctx: unknown) => ctx,
        createReplyDispatcherWithTyping: () => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        }),
        resolveHumanDelayConfig: () => undefined,
        dispatchReplyFromConfig: async () => ({}),
        withReplyDispatcher: async () => undefined,
      },
      reactions: { shouldAckReaction: () => false },
      // inbound surface is deliberately omitted to simulate the stale plugin
      // version used in issue #90325.
    },
    system: { enqueueSystemEvent: () => {} },
  };
}

function buildHandlerParams(core: unknown): MatrixMonitorHandlerParams {
  return {
    client: { getUserId: async () => "@bot:example.org" } as never,
    core: core as MatrixMonitorHandlerParams["core"],
    cfg: {} as never,
    accountId: "ops",
    runtime: { error: () => {} } as RuntimeEnv,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as RuntimeLogger,
    logVerboseMessage: () => {},
    allowFrom: [],
    groupPolicy: "open",
    replyToMode: "off",
    threadReplies: "off",
    streaming: "off",
    previewToolProgressEnabled: false,
    blockStreamingEnabled: false,
    dmEnabled: true,
    dmPolicy: "open",
    textLimit: 4000,
    mediaMaxBytes: 0,
    historyLimit: 0,
    startupMs: 0,
    startupGraceMs: 0,
    dropPreStartupMessages: false,
    directTracker: { isDirectMessage: async () => false },
    getRoomInfo: async () => ({ name: undefined, canonicalAlias: undefined, altAliases: [] }),
    getMemberDisplayName: async () => "",
    needsRoomAliasesForConfig: false,
  } as MatrixMonitorHandlerParams;
}

describe("createMatrixRoomMessageHandler stale runtime guard (#90325)", () => {
  it("throws an actionable error when core.channel.inbound.run is missing", () => {
    const core = buildCoreWithoutInbound();
    expect(() => createMatrixRoomMessageHandler(buildHandlerParams(core))).toThrow(
      /channel runtime is missing inbound\.run/,
    );
  });

  it("mentions the doctor + plugins install recovery path", () => {
    const core = buildCoreWithoutInbound();
    expect(() => createMatrixRoomMessageHandler(buildHandlerParams(core))).toThrow(
      /openclaw doctor --fix/,
    );
  });

  it("does not throw when core.channel.inbound.run is a function", () => {
    const core = buildCoreWithoutInbound() as {
      channel: { inbound?: { run: () => Promise<void> } };
    };
    core.channel.inbound = { run: async () => {} };
    // Note: full construction exercises many setters that depend on cfg shape;
    // we only assert the guard does not fire, by catching any later
    // construction errors and asserting the message is unrelated to the guard.
    try {
      createMatrixRoomMessageHandler(buildHandlerParams(core));
    } catch (err) {
      expect(String(err)).not.toMatch(/channel runtime is missing inbound\.run/);
    }
  });
});
