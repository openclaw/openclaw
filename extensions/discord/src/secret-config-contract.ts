// Discord helper module supports secret config contract behavior.
import {
  collectNestedChannelFieldAssignments,
  collectSecretInputAssignment,
  collectSimpleChannelFieldAssignments,
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

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.discord.accounts.*.pluralkit.token",
    targetType: "channels.discord.accounts.*.pluralkit.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.accounts.*.pluralkit.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.discord.accounts.*.token",
    targetType: "channels.discord.accounts.*.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.accounts.*.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.discord.accounts.*.voice.realtime.providers.*.apiKey",
    targetType: "channels.discord.accounts.*.voice.realtime.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.accounts.*.voice.realtime.providers.*.apiKey",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 7,
  },
  {
    id: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
    targetType: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 7,
  },
  {
    id: "channels.discord.pluralkit.token",
    targetType: "channels.discord.pluralkit.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.pluralkit.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.discord.token",
    targetType: "channels.discord.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.discord.voice.realtime.providers.*.apiKey",
    targetType: "channels.discord.voice.realtime.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.voice.realtime.providers.*.apiKey",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 5,
  },
  {
    id: "channels.discord.voice.tts.providers.*.apiKey",
    targetType: "channels.discord.voice.tts.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.voice.tts.providers.*.apiKey",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 5,
  },
];

function collectRealtimeProviderApiKeyAssignments(params: {
  realtime: unknown;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active: boolean;
  inactiveReason: string;
}): void {
  if (!isRecord(params.realtime) || !isRecord(params.realtime.providers)) {
    return;
  }
  for (const [providerId, providerConfig] of Object.entries(params.realtime.providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    collectSecretInputAssignment({
      value: providerConfig.apiKey,
      path: `${params.pathPrefix}.providers.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      owner: {
        ownerKind: "capability",
        ownerId: `${params.pathPrefix}.providers.${providerId}`,
        requiredForGateway: false,
        disposition: "isolate",
        contract: providerConfig,
      },
      apply: (value) => {
        providerConfig.apiKey = value;
      },
    });
  }
}

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
  const rootVoice = discord.voice;
  if (isRecord(rootVoice)) {
    collectRealtimeProviderApiKeyAssignments({
      realtime: rootVoice.realtime,
      pathPrefix: "channels.discord.voice.realtime",
      defaults: params.defaults,
      context: params.context,
      active: isBaseFieldActiveForChannelSurface(surface, "voice") && isEnabledFlag(rootVoice),
      inactiveReason:
        "no enabled Discord surface inherits this top-level voice config or voice is disabled.",
    });
  }
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    const accountVoice = account.voice;
    if (!isRecord(accountVoice)) {
      continue;
    }
    collectRealtimeProviderApiKeyAssignments({
      realtime: accountVoice.realtime,
      pathPrefix: `channels.discord.accounts.${accountId}.voice.realtime`,
      defaults: params.defaults,
      context: params.context,
      active: enabled && isEnabledFlag(accountVoice),
      inactiveReason: "Discord account is disabled or voice is disabled for this account.",
    });
  }
}
