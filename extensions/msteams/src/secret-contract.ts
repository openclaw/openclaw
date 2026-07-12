// Msteams plugin module implements secret contract behavior.
import {
  collectSecretInputAssignment,
  getChannelSurface,
  hasOwnProperty,
  isBaseFieldActiveForChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.msteams.accounts.*.appPassword",
    targetType: "channels.msteams.accounts.*.appPassword",
    configFile: "openclaw.json",
    pathPattern: "channels.msteams.accounts.*.appPassword",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.msteams.appPassword",
    targetType: "channels.msteams.appPassword",
    configFile: "openclaw.json",
    pathPattern: "channels.msteams.appPassword",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "msteams");
  if (!resolved) {
    return;
  }
  const { channel: msteams, surface } = resolved;

  collectSecretInputAssignment({
    value: msteams.appPassword,
    path: "channels.msteams.appPassword",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active:
      isBaseFieldActiveForChannelSurface(surface, "appPassword") ||
      isRootDefaultIdentityActive(msteams),
    inactiveReason: "no enabled account inherits this top-level Microsoft Teams appPassword.",
    apply: (value) => {
      msteams.appPassword = value;
    },
  });

  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (!hasOwnProperty(account, "appPassword")) {
      continue;
    }
    collectSecretInputAssignment({
      value: account.appPassword,
      path: `channels.msteams.accounts.${accountId}.appPassword`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: "Microsoft Teams account is disabled.",
      apply: (value) => {
        account.appPassword = value;
      },
    });
  }
}

function isConfiguredIdentityField(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function isRootDefaultIdentityActive(channel: Record<string, unknown>): boolean {
  return (
    channel.enabled !== false &&
    (isConfiguredIdentityField(channel.appId) || isConfiguredIdentityField(channel.appPassword))
  );
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
