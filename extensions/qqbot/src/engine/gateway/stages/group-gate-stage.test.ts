import { describe, expect, it, vi } from "vitest";
import type { QQBotInboundAccess } from "../../adapter/index.js";
import type { InboundPipelineDeps } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import type { GatewayAccount, GatewayPluginRuntime } from "../types.js";
import { runGroupGateStage } from "./group-gate-stage.js";

const emptyAllowlist = {
  source: [],
  normalized: [],
  hasConfiguredEntries: false,
  wildcard: false,
} as never;

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

function makeEvent(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "user-openid",
    messageId: "msg-1",
    content: "@bot help",
    timestamp: "2026-05-08T00:00:00.000Z",
    groupOpenid: "GROUP1",
    ...overrides,
  };
}

function makeRuntime(resolveMentionPatternsEnabled = vi.fn(() => true)): GatewayPluginRuntime {
  return {
    channel: {
      activity: { record: vi.fn() },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "qqbot:group:GROUP1",
          accountId: "qq-main",
        })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        finalizeInboundContext: vi.fn((fields: Record<string, unknown>) => fields),
        formatInboundEnvelope: vi.fn(() => "formatted inbound"),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw/qqbot-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      turn: { run: vi.fn() },
      text: { chunkMarkdownText: (text: string) => [text] },
      mentions: { resolveMentionPatternsEnabled },
    },
    tts: { textToSpeech: vi.fn() },
  };
}

function makeDeps(overrides: Partial<InboundPipelineDeps> = {}): InboundPipelineDeps {
  return {
    account,
    cfg: {
      messages: { groupChat: { mentionPatterns: ["^@bot\\b"] } },
    },
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: makeRuntime(),
    startTyping: vi.fn(async () => ({ keepAlive: null })),
    adapters: {
      history: {
        recordPendingHistoryEntry: vi.fn(() => []),
        buildPendingHistoryContext: vi.fn(() => ""),
        clearPendingHistory: vi.fn(),
      },
      mentionGate: {
        resolveInboundMentionDecision: vi.fn(({ facts, policy }) => ({
          effectiveWasMentioned: facts.wasMentioned,
          shouldSkip: policy.requireMention && !facts.wasMentioned,
          shouldBypassMention: false,
          implicitMention: false,
        })),
      },
      access: {
        resolveInboundAccess: vi.fn(
          (): QQBotInboundAccess => ({
            state: {
              channelId: "qqbot",
              accountId: "qq-main",
              conversationKind: "group",
              event: {
                kind: "message",
                authMode: "inbound",
                mayPair: true,
                hasOriginSubject: false,
                originSubjectMatched: false,
              },
              routeFacts: [],
              allowlists: {
                dm: emptyAllowlist,
                pairingStore: emptyAllowlist,
                group: emptyAllowlist,
                commandOwner: emptyAllowlist,
                commandGroup: emptyAllowlist,
              },
            },
            ingress: {
              admission: "dispatch",
              decision: "allow",
              decisiveGateId: "activation",
              reasonCode: "activation_allowed",
              graph: { gates: [] },
            },
            senderAccess: {
              allowed: true,
              decision: "allow",
              reasonCode: "group_policy_allowed",
              effectiveAllowFrom: [],
              effectiveGroupAllowFrom: [],
              providerMissingFallbackApplied: false,
            },
            commandAccess: {
              requested: false,
              authorized: false,
              shouldBlockControlCommand: false,
              reasonCode: "command_authorized",
            },
            routeAccess: { allowed: true },
            activationAccess: {
              ran: false,
              allowed: true,
              shouldSkip: false,
              reasonCode: "activation_allowed",
            },
          }),
        ),
        resolveSlashCommandAuthorization: vi.fn(() => false),
      },
      audioConvert: {
        convertSilkToWav: vi.fn(async () => null),
        isVoiceAttachment: vi.fn(() => false),
        formatDuration: vi.fn(() => "0s"),
      },
      outboundAudio: {
        audioFileToSilkBase64: vi.fn(async () => undefined),
        isAudioFile: vi.fn(() => false),
        shouldTranscodeVoice: vi.fn(() => false),
        waitForFile: vi.fn(async () => 0),
      },
      commands: {
        pluginVersion: "0.0.0-test",
        resolveVersion: vi.fn(() => "0.0.0"),
      },
    },
    ...overrides,
  };
}

describe("group-gate-stage", () => {
  it("gates QQ Bot configured mention patterns through scoped policy", () => {
    const resolveMentionPatternsEnabled = vi.fn(() => false);
    const deps = makeDeps({ runtime: makeRuntime(resolveMentionPatternsEnabled) });

    const result = runGroupGateStage({
      event: makeEvent(),
      deps,
      accountId: "qq-main",
      agentId: "agent-a",
      sessionKey: "qqbot:group:GROUP1",
      userContent: "@bot help",
      access: { commandAccess: { authorized: false } } as never,
    });

    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.skipReason).toBe("skip_no_mention");
    }
    expect(resolveMentionPatternsEnabled).toHaveBeenCalledWith({
      cfg: deps.cfg,
      provider: "qqbot",
      conversationId: "qqbot:group:GROUP1",
      providerPolicy: undefined,
      agentId: "agent-a",
    });
  });

  it("still allows configured pattern mentions when scoped policy enables them", () => {
    const deps = makeDeps({ runtime: makeRuntime(vi.fn(() => true)) });

    const result = runGroupGateStage({
      event: makeEvent(),
      deps,
      accountId: "qq-main",
      agentId: "agent-a",
      sessionKey: "qqbot:group:GROUP1",
      userContent: "@bot help",
      access: { commandAccess: { authorized: false } } as never,
    });

    expect(result.kind).toBe("pass");
    expect(result.groupInfo.gate.effectiveWasMentioned).toBe(true);
  });
});
