import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  isBaseFieldActiveForChannelSurface,
  isEnabledFlag,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { collectNestedChannelTtsAssignments } from "openclaw/plugin-sdk/channel-secret-tts-runtime";

export function discordRealtimeVoiceSecretOwnerId(accountId: string, providerId: string): string {
  return `discord:voice:realtime:${normalizeAccountId(accountId)}:${providerId}`;
}

function isRealtimeVoiceActive(value: unknown): boolean {
  return isRecord(value) && isEnabledFlag(value) && value.mode !== "stt-tts";
}

const secretPaths = [
  "pluralkit.token",
  "token",
  "voice.realtime.providers.*.apiKey",
  "voice.tts.providers.*.apiKey",
  "voice.tts.personas.*.providers.*.apiKey",
];

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] =
  createChannelSecretTargetRegistryEntries({
    channelKey: "discord",
    account: secretPaths,
    channel: secretPaths,
  }).map((entry) => {
    if (entry.pathPattern.endsWith(".providers.*.apiKey")) {
      entry.providerIdPathSegmentIndex = entry.pathPattern.split(".").length - 2;
    }
    return entry;
  });

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "discord");
  if (!resolved) {
    return;
  }
  const { channel: discord, surface } = resolved;
  const hasImplicitDefault =
    surface.hasExplicitAccounts &&
    !surface.accounts.some(({ accountId }) => accountId === "default") &&
    [discord.token, params.context.env.DISCORD_BOT_TOKEN].some((value) =>
      hasConfiguredSecretInputValue(value, params.defaults),
    );
  if (hasImplicitDefault) {
    // Account discovery treats either token source as an implicit default. Keep it in
    // secret collection so named accounts cannot orphan the default's inherited refs.
    surface.accounts.push({
      accountId: "default",
      account: {},
      enabled: surface.channelEnabled,
    });
  }
  collectSimpleChannelFieldAssignments({
    channelKey: "discord",
    field: "token",
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Discord token.",
    accountInactiveReason: "Discord account is disabled.",
  });
  collectNestedChannelFieldAssignments({
    channelKey: "discord",
    nestedKey: "pluralkit",
    field: "token",
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "pluralkit") &&
      isRecord(discord.pluralkit) &&
      isEnabledFlag(discord.pluralkit),
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !Object.hasOwn(account, "pluralkit") && isEnabledFlag(discord.pluralkit),
    topInactiveReason:
      "no enabled Discord surface inherits this top-level PluralKit config or PluralKit is disabled.",
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.pluralkit) && isEnabledFlag(account.pluralkit),
    accountInactiveReason: "Discord account is disabled or PluralKit is disabled for this account.",
  });
  collectNestedChannelTtsAssignments({
    channelKey: "discord",
    nestedKey: "voice",
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "voice") &&
      isRecord(discord.voice) &&
      isEnabledFlag(discord.voice),
    topInactiveReason:
      "no enabled Discord surface inherits this top-level voice config or voice is disabled.",
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.voice) && isEnabledFlag(account.voice),
    accountInactiveReason: "Discord account is disabled or voice is disabled for this account.",
  });
  collectNestedChannelTtsAssignments({
    channelKey: "discord",
    nestedKey: "voice",
    providerBlockKey: "realtime",
    ownerId: ({ accountId, providerId }) =>
      discordRealtimeVoiceSecretOwnerId(accountId, providerId),
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "voice") && isRealtimeVoiceActive(discord.voice),
    topInactiveReason:
      "no enabled Discord surface uses this top-level realtime voice config, voice is disabled, or voice mode is stt-tts.",
    accountActive: ({ account, enabled }) => enabled && isRealtimeVoiceActive(account.voice),
    accountInactiveReason:
      "Discord account is disabled, voice is disabled, or voice mode is stt-tts for this account.",
  });
}
