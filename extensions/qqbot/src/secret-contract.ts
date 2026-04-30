import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  normalizeSecretStringValue,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.qqbot.accounts.*.clientSecret",
    targetType: "channels.qqbot.accounts.*.clientSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.qqbot.accounts.*.clientSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.qqbot.clientSecret",
    targetType: "channels.qqbot.clientSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.qqbot.clientSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

function hasClientSecretFile(value: unknown): boolean {
  return normalizeSecretStringValue(value).length > 0;
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "qqbot");
  if (!resolved) {
    return;
  }

  const { channel: qqbot, surface } = resolved;
  const baseClientSecretFile = hasClientSecretFile(qqbot.clientSecretFile);
  const accountClientSecretFile = (account: Record<string, unknown>) =>
    hasClientSecretFile(account.clientSecretFile);

  collectConditionalChannelFieldAssignments({
    channelKey: "qqbot",
    field: "clientSecret",
    channel: qqbot,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: !baseClientSecretFile,
    topLevelInheritedAccountActive: ({ account, enabled }) => {
      if (!enabled || baseClientSecretFile) {
        return false;
      }
      return (
        !hasConfiguredSecretInputValue(account.clientSecret, params.defaults) &&
        !accountClientSecretFile(account)
      );
    },
    accountActive: ({ account, enabled }) => enabled && !accountClientSecretFile(account),
    topInactiveReason:
      "no enabled QQBot surface inherits this top-level clientSecret (clientSecretFile is configured).",
    accountInactiveReason: "QQBot account is disabled or clientSecretFile is configured.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
