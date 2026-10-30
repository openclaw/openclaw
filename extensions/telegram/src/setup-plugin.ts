import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { inspectTelegramAccount } from "./account-inspect.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { telegramConfigAdapter } from "./config-adapter.js";
import { TelegramChannelConfigSchema } from "./config-schema.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

const TELEGRAM_CHANNEL = "telegram" as const;

export function createTelegramSetupPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupWizard"]>;
  setupContract: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupContract"]>;
}) {
  return {
    id: TELEGRAM_CHANNEL,
    setupContract: params.setupContract,
    meta: {
      ...getChatChannelMeta(TELEGRAM_CHANNEL),
      quickstartAllowFrom: true,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      reactionSlots: "single",
      threads: true,
      media: true,
      tts: {
        voice: {
          synthesisTarget: "voice-note",
          captionedFinalText: true,
        },
      },
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
    reload: {
      configPrefixes: ["channels.telegram"],
      noopPrefixes: [
        "messages.inbound",
        "messages.ackReactionScope",
        // These settings are captured at ingress/turn admission. Transport and
        // native command registration keep the channel-wide restart fallback.
        ...[
          "dmPolicy",
          "allowFrom",
          "groupAllowFrom",
          "groupPolicy",
          "replyToMode",
          "streaming",
          "textChunkLimit",
        ].flatMap((key) => [`channels.telegram.${key}`, `channels.telegram.accounts.*.${key}`]),
      ],
    },
    configSchema: TelegramChannelConfigSchema,
    config: {
      ...telegramConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim().length > 0,
      isConfigured: (account, cfg) => {
        const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
        // Configured-unavailable credentials remain visible but cannot start the runtime.
        return inspected.configured && Boolean(inspected.token.trim());
      },
      unconfiguredReason: (account, cfg) => {
        const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
        return (
          inspected.stateReason ??
          (inspected.tokenStatus === "configured_unavailable"
            ? `not configured: token ${inspected.tokenSource} is configured but unavailable`
            : "not configured")
        );
      },
      describeAccount: (account, cfg) => {
        const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: inspected.configured,
          tokenSource: inspected.tokenSource,
          tokenStatus: inspected.tokenStatus,
        };
      },
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
  } satisfies ChannelPlugin<ResolvedTelegramAccount>;
}
