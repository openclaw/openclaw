import {
  collectSecretInputAssignment,
  hasOwnProperty,
  isEnabledFlag,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const CHANNEL_KEY = "channel-broker";
const SECRET_FIELDS = ["outboundToken", "signingSecret"] as const;

type SecretField = (typeof SECRET_FIELDS)[number];

type ProviderEntry = {
  key: "accounts" | "providers";
  accountId: string;
  account: Record<string, unknown>;
  enabled: boolean;
};

export const secretTargetRegistryEntries: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[] =
  SECRET_FIELDS.flatMap((field) => [
    {
      id: `channels.${CHANNEL_KEY}.${field}`,
      targetType: `channels.${CHANNEL_KEY}.${field}`,
      configFile: "openclaw.json",
      pathPattern: `channels.${CHANNEL_KEY}.${field}`,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: `channels.${CHANNEL_KEY}.accounts.*.${field}`,
      targetType: `channels.${CHANNEL_KEY}.accounts.*.${field}`,
      configFile: "openclaw.json",
      pathPattern: `channels.${CHANNEL_KEY}.accounts.*.${field}`,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: `channels.${CHANNEL_KEY}.providers.*.${field}`,
      targetType: `channels.${CHANNEL_KEY}.providers.*.${field}`,
      configFile: "openclaw.json",
      pathPattern: `channels.${CHANNEL_KEY}.providers.*.${field}`,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
  ]);

function getChannelBrokerRecord(config: {
  channels?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const channel = config.channels?.[CHANNEL_KEY];
  return isRecord(channel) ? channel : undefined;
}

function collectProviderEntries(channel: Record<string, unknown>): ProviderEntry[] {
  return (["accounts", "providers"] as const).flatMap((key) => {
    const accounts = channel[key];
    if (!isRecord(accounts)) {
      return [];
    }
    return Object.entries(accounts).flatMap(([accountId, account]) => {
      if (!isRecord(account)) {
        return [];
      }
      return [
        {
          key,
          accountId,
          account,
          enabled: isEnabledFlag(channel) && isEnabledFlag(account),
        },
      ];
    });
  });
}

function collectBrokerSecretFieldAssignments(params: {
  channel: Record<string, unknown>;
  field: SecretField;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const providerEntries = collectProviderEntries(params.channel);
  const channelEnabled = isEnabledFlag(params.channel);
  const topLevelActive =
    channelEnabled &&
    (providerEntries.length === 0 ||
      providerEntries.some(
        (entry) => entry.enabled && !hasOwnProperty(entry.account, params.field),
      ));
  collectSecretInputAssignment({
    value: params.channel[params.field],
    path: `channels.${CHANNEL_KEY}.${params.field}`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelActive,
    inactiveReason: `no enabled broker provider inherits this top-level ${params.field}.`,
    apply: (value) => {
      params.channel[params.field] = value;
    },
  });
  for (const entry of providerEntries) {
    if (!hasOwnProperty(entry.account, params.field)) {
      continue;
    }
    collectSecretInputAssignment({
      value: entry.account[params.field],
      path: `channels.${CHANNEL_KEY}.${entry.key}.${entry.accountId}.${params.field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: entry.enabled,
      inactiveReason: "Channel broker provider is disabled.",
      apply: (value) => {
        entry.account[params.field] = value;
      },
    });
  }
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelBrokerRecord(params.config);
  if (!channel) {
    return;
  }
  for (const field of SECRET_FIELDS) {
    collectBrokerSecretFieldAssignments({
      channel,
      field,
      defaults: params.defaults,
      context: params.context,
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
