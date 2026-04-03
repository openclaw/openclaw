import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/security-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.telegram.accounts.*.botToken",
    targetType: "channels.telegram.accounts.*.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.telegram.accounts.*.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.telegram.accounts.*.webhookSecret",
    targetType: "channels.telegram.accounts.*.webhookSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.telegram.accounts.*.webhookSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.telegram.botToken",
    targetType: "channels.telegram.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.telegram.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.telegram.webhookSecret",
    targetType: "channels.telegram.webhookSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.telegram.webhookSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "telegram");
  if (!resolved) {
    return;
  }
  const { channel: telegram, surface } = resolved;
  const baseTokenFile = typeof telegram.tokenFile === "string" ? telegram.tokenFile.trim() : "";
  const accountTokenFile = (account: Record<string, unknown>) =>
    typeof account.tokenFile === "string" ? account.tokenFile.trim() : "";
  collectConditionalChannelFieldAssignments({
    channelKey: "telegram",
    field: "botToken",
    channel: telegram,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseTokenFile.length === 0,
    topLevelInheritedAccountActive: ({ account, enabled }) => {
      if (!enabled || baseTokenFile.length > 0) {
        return false;
      }
      const accountBotTokenConfigured = hasConfiguredSecretInputValue(
        account.botToken,
        params.defaults,
      );
      return !accountBotTokenConfigured && accountTokenFile(account).length === 0;
    },
    accountActive: ({ account, enabled }) => enabled && accountTokenFile(account).length === 0,
    topInactiveReason:
      "no enabled Telegram surface inherits this top-level botToken (tokenFile is configured).",
    accountInactiveReason: "Telegram account is disabled or tokenFile is configured.",
  });
  const baseWebhookUrl = typeof telegram.webhookUrl === "string" ? telegram.webhookUrl.trim() : "";
  const accountWebhookUrl = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "webhookUrl")
      ? typeof account.webhookUrl === "string"
        ? account.webhookUrl.trim()
        : ""
      : baseWebhookUrl;
  collectConditionalChannelFieldAssignments({
    channelKey: "telegram",
    field: "webhookSecret",
    channel: telegram,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "webhookSecret") && accountWebhookUrl(account).length > 0,
    accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
    topInactiveReason:
      "no enabled Telegram webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
    accountInactiveReason:
      "Telegram account is disabled or webhook mode is not active for this account.",
  });
}
