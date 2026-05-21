import {
  collectSecretInputAssignment,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const LINE_SECRET_FIELDS = ["channelAccessToken", "channelSecret"] as const;

type LineSecretField = (typeof LINE_SECRET_FIELDS)[number];

function createLineSecretEntry(field: LineSecretField): SecretTargetRegistryEntry {
  const path = `channels.line.${field}`;
  return {
    id: path,
    targetType: path,
    configFile: "openclaw.json",
    pathPattern: path,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  };
}

function createLineAccountSecretEntry(field: LineSecretField): SecretTargetRegistryEntry {
  const path = `channels.line.accounts.*.${field}`;
  return {
    id: path,
    targetType: path,
    configFile: "openclaw.json",
    pathPattern: path,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    accountIdPathSegmentIndex: 3,
  };
}

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  createLineAccountSecretEntry("channelAccessToken"),
  createLineAccountSecretEntry("channelSecret"),
  createLineSecretEntry("channelAccessToken"),
  createLineSecretEntry("channelSecret"),
];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "line");
  if (!resolved) {
    return;
  }

  const { channel: line, surface } = resolved;
  for (const field of LINE_SECRET_FIELDS) {
    collectSecretInputAssignment({
      value: line[field],
      path: `channels.line.${field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: surface.channelEnabled,
      inactiveReason: "LINE channel is disabled.",
      apply: (value) => {
        line[field] = value;
      },
    });
  }

  if (!surface.hasExplicitAccounts) {
    return;
  }

  for (const { accountId, account, enabled } of surface.accounts) {
    for (const field of LINE_SECRET_FIELDS) {
      if (!hasOwnProperty(account, field)) {
        continue;
      }
      collectSecretInputAssignment({
        value: account[field],
        path: `channels.line.accounts.${accountId}.${field}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "LINE account is disabled.",
        apply: (value) => {
          account[field] = value;
        },
      });
    }
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
