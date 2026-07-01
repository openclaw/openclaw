// ClickClack plugin module implements secret contract behavior.
import {
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  isBaseFieldActiveForChannelSurface,
  normalizeSecretStringValue,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { collectSecretInputAssignment } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { getChannelSurface } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { SecretTargetRegistryEntry } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.clickclack.token",
    targetType: "channels.clickclack.token",
    configFile: "openclaw.json",
    pathPattern: "channels.clickclack.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.clickclack.accounts.*.token",
    targetType: "channels.clickclack.accounts.*.token",
    configFile: "openclaw.json",
    pathPattern: "channels.clickclack.accounts.*.token",
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
  const resolved = getChannelSurface(params.config, "clickclack");
  if (!resolved) {
    return;
  }
  const { channel: clickclack, surface } = resolved;
  const hasImplicitDefaultAccount =
    surface.channelEnabled &&
    typeof normalizeSecretStringValue(clickclack.workspace) === "string" &&
    typeof normalizeSecretStringValue(clickclack.baseUrl) === "string" &&
    hasConfiguredSecretInputValue(clickclack.token, params.defaults);
  const topLevelTokenActive =
    hasImplicitDefaultAccount || isBaseFieldActiveForChannelSurface(surface, "token");
  collectSecretInputAssignment({
    value: clickclack.token,
    path: "channels.clickclack.token",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelTokenActive,
    inactiveReason: "no enabled account inherits this top-level ClickClack token.",
    apply: (value) => {
      clickclack.token = value;
    },
  });
  if (surface.hasExplicitAccounts) {
    for (const { accountId, account, enabled } of surface.accounts) {
      if (!hasOwnProperty(account, "token")) {
        continue;
      }
      collectSecretInputAssignment({
        value: account.token,
        path: `channels.clickclack.accounts.${accountId}.token`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "ClickClack account is disabled.",
        apply: (value) => {
          account.token = value;
        },
      });
    }
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
