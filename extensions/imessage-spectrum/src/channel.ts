import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { patchChannelConfigForAccount } from "openclaw/plugin-sdk/setup-runtime";
import { normalizeStringifiedEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listSpectrumAccountIds,
  resolveDefaultSpectrumAccountId,
  resolveSpectrumAccount,
  type ResolvedSpectrumAccount,
} from "./accounts.js";

const CHANNEL = "imessage-spectrum" as const;

const EMOJI_TO_TAPBACK: Record<string, string> = {
  "❤️": "love",
  "❤": "love",
  "👍": "like",
  "👎": "dislike",
  "😂": "laugh",
  "‼️": "emphasize",
  "‼": "emphasize",
  "❓": "question",
};

function resolveTapbackParam(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return EMOJI_TO_TAPBACK[trimmed] ?? trimmed;
}

const SPECTRUM_EFFECT_NAMES = [
  "slam",
  "loud",
  "gentle",
  "invisible",
  "confetti",
  "fireworks",
  "balloons",
  "heart",
  "lasers",
  "celebration",
  "sparkles",
  "spotlight",
  "echo",
] as const;

const SPECTRUM_EFFECT_SCHEMA = {
  type: "string",
  enum: SPECTRUM_EFFECT_NAMES,
  description:
    "iMessage effect for this send. Bubble effects: slam, loud, gentle, invisible. Screen effects: confetti, fireworks, balloons, heart, lasers, celebration, sparkles, spotlight, echo.",
} as const;

const SPECTRUM_EFFECT_PARAM_KEYS = [
  "effectName",
  "effect_name",
  "effectId",
  "effect_id",
  "effect",
  "imessageEffect",
  "imessage_effect",
  "iMessageEffect",
];

function readOptionalActionParam(
  params: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" || typeof value === "number") {
      const trimmed = String(value).trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function resolveExplicitNativeReplyToId(ctx: {
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  payload?: { replyToId?: unknown };
}): string | undefined {
  const replyToId = typeof ctx.replyToId === "string" ? ctx.replyToId.trim() : "";
  if (!replyToId || ctx.replyToIdSource === "implicit") {
    return undefined;
  }
  if (ctx.replyToIdSource === "explicit") {
    return replyToId;
  }
  if (ctx.payload && Object.prototype.hasOwnProperty.call(ctx.payload, "replyToId")) {
    const payloadReplyToId = ctx.payload.replyToId;
    if (typeof payloadReplyToId === "string" || typeof payloadReplyToId === "number") {
      const normalized = String(payloadReplyToId).trim();
      return normalized ? normalized : undefined;
    }
  }
  return undefined;
}

type SpectrumSetupInput = {
  projectId?: unknown;
  projectSecret?: unknown;
  secret?: unknown;
  webhookSecret?: unknown;
  webhookBaseUrl?: unknown;
};

const loadChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

async function sendSpectrumOutboundPayload(params: {
  to: string;
  text: string;
  mediaUrl?: string;
  replyToId?: string | null;
  audioAsVoice?: boolean;
  contentBuilder?: import("spectrum-ts").ContentBuilder;
  effectName?: string;
}) {
  const runtime = await loadChannelRuntime();
  return runtime.sendSpectrumOutboundPayload(params as any);
}

const spectrumConfig = createScopedChannelConfigAdapter<ResolvedSpectrumAccount>({
  sectionKey: CHANNEL,
  listAccountIds: (cfg) => listSpectrumAccountIds(cfg),
  resolveAccount: adaptScopedAccountAccessor((params) => resolveSpectrumAccount(params)),
  defaultAccountId: (cfg) => resolveDefaultSpectrumAccountId(cfg),
  clearBaseFields: [
    "projectId",
    "projectSecret",
    "webhookSecret",
    "webhookBaseUrl",
    "deliveryRetryCount",
    "deliveryRetryDelayMs",
    "deliveryQueueSize",
    "enableSessionContext",
    "sessionContext",
    "tunnelPort",
    "name",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => normalizeStringifiedEntries(allowFrom).filter(Boolean),
  resolveDefaultTo: (_account) => undefined,
  inspectAccount(cfg, accountId) {
    const account = resolveSpectrumAccount({ cfg, accountId });
    return {
      enabled: account.enabled,
      configured: account.configured,
      tokenStatus: account.webhookConfigured
        ? "available"
        : account.configured
          ? "missing"
          : "missing",
    };
  },
});

const spectrumBase = {
  ...createChannelPluginBase({
    id: CHANNEL,
    config: spectrumConfig,
    setup: {
      resolveAccountId: (params) =>
        resolveSpectrumAccount({
          cfg: params.cfg,
          accountId: params.accountId ?? resolveDefaultSpectrumAccountId(params.cfg),
        }).accountId,
      resolveBindingAccountId: (params) =>
        resolveSpectrumAccount({ cfg: params.cfg, accountId: params.accountId }).accountId,
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const spectrumInput = input as SpectrumSetupInput;
        const projectSecret = spectrumInput.projectSecret ?? spectrumInput.secret;
        return patchChannelConfigForAccount({
          cfg,
          channel: CHANNEL,
          accountId,
          patch: {
            enabled: true,
            ...(spectrumInput.projectId ? { projectId: String(spectrumInput.projectId) } : {}),
            ...(projectSecret ? { projectSecret: String(projectSecret) } : {}),
            ...(spectrumInput.webhookSecret
              ? { webhookSecret: String(spectrumInput.webhookSecret) }
              : {}),
            ...(spectrumInput.webhookBaseUrl
              ? { webhookBaseUrl: String(spectrumInput.webhookBaseUrl) }
              : {}),
          },
        });
      },
    },
    agentPrompt: {
      messageToolHints: () => [
        "- iMessage effects: when sending text or media, set `effectName` to one of slam, loud, gentle, invisible, confetti, fireworks, balloons, heart, lasers, celebration, sparkles, spotlight, or echo. Do not say effects are unsupported.",
        "- iMessage replies: normal main-chat responses should not set `replyToId`; only set it when intentionally replying inside a user-created iMessage thread.",
      ],
    },
  }),
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: CHANNEL,
    resolveAccount: resolveSpectrumAccount,
    normalize: ({ cfg, accountId, values }) =>
      spectrumConfig.formatAllowFrom!({
        cfg,
        accountId: accountId ?? undefined,
        allowFrom: values,
      }),
    resolveDmAllowFrom: (account: ResolvedSpectrumAccount) => account.config.allowFrom,
    resolveGroupAllowFrom: (account: ResolvedSpectrumAccount) => account.config.groupAllowFrom,
    resolveDmPolicy: (account: ResolvedSpectrumAccount) => account.config.dmPolicy,
    resolveGroupPolicy: (account: ResolvedSpectrumAccount) =>
      account.config.groupPolicy === "open" ? "open" : "allowlist",
  }),
  messaging: {
    resolveSessionConversation(params: { kind: "group" | "channel"; rawId: string }) {
      return {
        id: params.rawId,
        baseConversationId: params.rawId,
        parentConversationCandidates: [],
      };
    },
  },
  threading: {
    resolveReplyToMode: () => "off" as const,
  },
  message: defineChannelMessageAdapter({
    id: CHANNEL,
    durableFinal: {
      capabilities: {
        text: true,
        media: true,
        replyTo: true,
      },
    },
    send: {
      text: async (ctx) => {
        const replyToId = resolveExplicitNativeReplyToId(ctx);
        const result = await sendSpectrumOutboundPayload({
          to: ctx.to,
          text: ctx.text,
          replyToId,
        });
        return {
          receipt: {
            platformMessageIds: result.messageId ? [result.messageId] : [],
            parts: [],
            sentAt: Date.now(),
          },
          messageId: result.messageId,
        };
      },
      media: async (ctx) => {
        const replyToId = resolveExplicitNativeReplyToId(ctx);
        const result = await sendSpectrumOutboundPayload({
          to: ctx.to,
          text: ctx.text,
          mediaUrl: ctx.mediaUrl,
          replyToId,
          audioAsVoice: ctx.audioAsVoice,
        });
        return {
          receipt: {
            platformMessageIds: result.messageId ? [result.messageId] : [],
            parts: [{ index: 0, kind: "media", platformMessageId: result.messageId }],
            sentAt: Date.now(),
            ...(replyToId ? { replyToId } : {}),
          },
          messageId: result.messageId,
        };
      },
      payload: async (ctx) => {
        const runtime = await loadChannelRuntime();
        return await runtime.sendSpectrumPayload(ctx);
      },
    },
  }),
  heartbeat: {
    sendTyping: async ({ to }: { to: string }) => {
      const runtime = await loadChannelRuntime();
      await runtime.sendSpectrumTypingIndicator({ to });
    },
  },
  streaming: {
    withTypingIndicators: true,
  },
  actions: {
    describeMessageTool: () => ({
      actions: ["send", "react"],
      schema: {
        actions: ["send"],
        properties: {
          effectName: SPECTRUM_EFFECT_SCHEMA,
          effect_name: SPECTRUM_EFFECT_SCHEMA,
          effect_id: SPECTRUM_EFFECT_SCHEMA,
          imessageEffect: SPECTRUM_EFFECT_SCHEMA,
          imessage_effect: SPECTRUM_EFFECT_SCHEMA,
          iMessageEffect: SPECTRUM_EFFECT_SCHEMA,
        },
      },
    }),
    prepareSendPayload: ({ ctx, payload }: any) => {
      if (ctx.action !== "send") {
        return null;
      }
      const effectName = readOptionalActionParam(
        (ctx.params ?? {}) as Record<string, unknown>,
        SPECTRUM_EFFECT_PARAM_KEYS,
      );
      return effectName ? ({ ...payload, effectName } as any) : payload;
    },
    messageActionTargetAliases: {
      react: {
        aliases: [
          "messageId",
          "message_id",
          "targetMessageId",
          "target_message_id",
          "chatGuid",
          "chat_guid",
          "spaceId",
          "space_id",
          "chatId",
          "chat_id",
          "conversationId",
          "conversation_id",
        ],
        deliveryTargetAliases: [
          "chatGuid",
          "chat_guid",
          "spaceId",
          "space_id",
          "chatId",
          "chat_id",
          "conversationId",
          "conversation_id",
        ],
      },
    },
    supportsAction: ({ action }: { action: string }) => action === "react",
    handleAction: async (ctx: any) => {
      const actionParams = (ctx.params ?? {}) as Record<string, unknown>;
      const emoji = readOptionalActionParam(actionParams, ["emoji", "reaction", "tapback"]) ?? "";
      const messageId =
        readOptionalActionParam(actionParams, [
          "messageId",
          "message_id",
          "targetMessageId",
          "target_message_id",
        ]) ?? "";
      const target = readOptionalActionParam(actionParams, [
        "target",
        "to",
        "chatGuid",
        "chat_guid",
        "spaceId",
        "space_id",
        "chatId",
        "chat_id",
        "conversationId",
        "conversation_id",
      ]);

      if (!emoji || !messageId) {
        return { status: "error" as const, message: "emoji and messageId are required" };
      }

      try {
        const runtime = await loadChannelRuntime();
        await runtime.sendSpectrumReactionForMessage({
          targetMessageId: messageId,
          tapback: resolveTapbackParam(emoji),
          target,
        });
        return { status: "success" as const, message: `Sent ${emoji}` };
      } catch (err: any) {
        if (err?.message?.includes("Expected message resource GUID")) {
          return {
            status: "success" as const,
            message: `Ignored ${emoji} (not supported on shared number)`,
          };
        }
        return { status: "error" as const, message: String(err) };
      }
    },
  },
};

export const imessageSpectrumPlugin = createChatChannelPlugin<ResolvedSpectrumAccount>({
  base: spectrumBase as any,

  security: createRestrictSendersChannelSecurity<ResolvedSpectrumAccount>({
    channelKey: CHANNEL,
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveGroupPolicy: (account: ResolvedSpectrumAccount) =>
      account.config.groupPolicy === "open" ? "open" : "allowlist",
    surface: "iMessage Spectrum",
    openScope: "any sender",
    groupPolicyPath: `channels.${CHANNEL}.groupPolicy`,
    groupAllowFromPath: `channels.${CHANNEL}.groupAllowFrom`,
    mentionGated: false,
    policyPathSuffix: "dmPolicy",
    normalizeDmEntry: (raw) => raw.trim(),
  }),

  outbound: {
    attachedResults: {
      channel: CHANNEL,
      sendText: async (params) => {
        const result = await sendSpectrumOutboundPayload({
          to: params.to,
          text: params.text,
        });
        return { messageId: result.messageId };
      },
    },
    base: {
      deliveryMode: "direct" as const,
    },
  },
});
