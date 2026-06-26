// Feishu plugin module implements secret contract behavior.
import {
  collectConditionalChannelFieldAssignments,
  collectSecretInputAssignment,
  getChannelSurface,
  hasOwnProperty,
  hasConfiguredSecretInputValue,
  isBaseFieldActiveForChannelSurface,
  normalizeSecretStringValue,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.feishu.accounts.*.appSecret",
    targetType: "channels.feishu.accounts.*.appSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.feishu.accounts.*.appSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.feishu.accounts.*.encryptKey",
    targetType: "channels.feishu.accounts.*.encryptKey",
    configFile: "openclaw.json",
    pathPattern: "channels.feishu.accounts.*.encryptKey",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.feishu.accounts.*.verificationToken",
    targetType: "channels.feishu.accounts.*.verificationToken",
    configFile: "openclaw.json",
    pathPattern: "channels.feishu.accounts.*.verificationToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.feishu.appSecret",
    targetType: "channels.feishu.appSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.feishu.appSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.feishu.encryptKey",
    targetType: "channels.feishu.encryptKey",
    configFile: "openclaw.json",
    pathPattern: "channels.feishu.encryptKey",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.feishu.verificationToken",
    targetType: "channels.feishu.verificationToken",
    configFile: "openclaw.json",
    pathPattern: "channels.feishu.verificationToken",
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
  const resolved = getChannelSurface(params.config, "feishu");
  if (!resolved) {
    return;
  }
  const { channel: feishu, surface } = resolved;
  // Feishu account listing starts an implicit default account from top-level credentials
  // even when every named account overrides appSecret.
  const hasImplicitDefaultAccount =
    surface.channelEnabled &&
    hasConfiguredSecretInputValue(feishu.appId, params.defaults) &&
    hasConfiguredSecretInputValue(feishu.appSecret, params.defaults);
  const topLevelAppSecretActive =
    hasImplicitDefaultAccount || isBaseFieldActiveForChannelSurface(surface, "appSecret");
  collectSecretInputAssignment({
    value: feishu.appSecret,
    path: "channels.feishu.appSecret",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelAppSecretActive,
    inactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
    apply: (value) => {
      feishu.appSecret = value;
    },
  });
  if (surface.hasExplicitAccounts) {
    for (const { accountId, account, enabled } of surface.accounts) {
      if (!hasOwnProperty(account, "appSecret")) {
        continue;
      }
      collectSecretInputAssignment({
        value: account.appSecret,
        path: `channels.feishu.accounts.${accountId}.appSecret`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Feishu account is disabled.",
        apply: (value) => {
          account.appSecret = value;
        },
      });
    }
  }
  const baseConnectionMode =
    normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
  const resolveAccountMode = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "connectionMode")
      ? normalizeSecretStringValue(account.connectionMode)
      : baseConnectionMode;
  collectConditionalChannelFieldAssignments({
    channelKey: "feishu",
    field: "encryptKey",
    channel: feishu,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "encryptKey") &&
      resolveAccountMode(account) === "webhook",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
    topInactiveReason: "no enabled Feishu webhook-mode surface inherits this top-level encryptKey.",
    accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
  });
  collectConditionalChannelFieldAssignments({
    channelKey: "feishu",
    field: "verificationToken",
    channel: feishu,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "verificationToken") &&
      resolveAccountMode(account) === "webhook",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
    topInactiveReason:
      "no enabled Feishu webhook-mode surface inherits this top-level verificationToken.",
    accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
