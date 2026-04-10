import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";
import { z } from "openclaw/plugin-sdk/zod";

const nonEmptyOptionalString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message }).optional();

const TelegramDirectSessionsConfigSchema = z
  .strictObject({
    enabled: z.boolean({ error: "directSessions.enabled must be a boolean" }).optional(),
    providerOverride: nonEmptyOptionalString(
      "directSessions.providerOverride must be a non-empty string",
    ),
    modelOverride: nonEmptyOptionalString(
      "directSessions.modelOverride must be a non-empty string",
    ),
    prependSystemContext: nonEmptyOptionalString(
      "directSessions.prependSystemContext must be a non-empty string",
    ),
  })
  .optional();

const TelegramPluginConfigRuntimeSchema = z.strictObject({
  directSessions: TelegramDirectSessionsConfigSchema,
});

export type TelegramDirectSessionsConfig = {
  enabled?: boolean;
  providerOverride?: string;
  modelOverride?: string;
  prependSystemContext?: string;
};

export type TelegramPluginConfig = {
  directSessions?: TelegramDirectSessionsConfig;
};

export const telegramPluginConfigUiHints = {
  "": {
    label: "Telegram Plugin",
    help: "Telegram plugin-owned routing and prompt controls for direct-message sessions.",
  },
  directSessions: {
    label: "Telegram Direct Sessions",
    help: "DM-only routing overrides and stable prompt guidance owned by the Telegram plugin.",
    advanced: true,
  },
  "directSessions.enabled": {
    label: "Telegram Direct Session Routing Enabled",
    help: "When false, Telegram direct-session plugin overrides stay disabled even if other directSessions fields are configured.",
    advanced: true,
  },
  "directSessions.providerOverride": {
    label: "Telegram Direct Session Provider Override",
    help: "Optional provider override applied only to Telegram direct-message sessions, for example `vllm` or `openai-codex`.",
    advanced: true,
  },
  "directSessions.modelOverride": {
    label: "Telegram Direct Session Model Override",
    help: "Optional model override applied only to Telegram direct-message sessions, for example `gpt-5.4-mini` or `qwen/qwen3-coder-30b`.",
    advanced: true,
  },
  "directSessions.prependSystemContext": {
    label: "Telegram Direct Session System Context",
    help: "Stable system-prompt prefix prepended only for Telegram direct-message sessions. Use this for cached guidance instead of per-turn user-context injection.",
    advanced: true,
  },
} satisfies Record<string, ChannelConfigUiHint>;

export const telegramPluginConfigSchema = buildChannelConfigSchema(
  TelegramPluginConfigRuntimeSchema,
  {
    uiHints: telegramPluginConfigUiHints,
  },
);

export function resolveTelegramPluginConfig(value: unknown): TelegramPluginConfig {
  if (value === undefined) {
    return {};
  }
  const parsed = TelegramPluginConfigRuntimeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const message = issue?.message ?? "invalid config";
  throw new Error(`Invalid telegram plugin config: ${message}`);
}
