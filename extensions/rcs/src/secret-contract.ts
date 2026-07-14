// Rcs plugin module implements secret contract behavior.
import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const DEFAULT_ACCOUNT_ID = "default";

export const secretTargetRegistryEntries = [
  {
    id: "channels.rcs.accounts.*.authToken",
    targetType: "channels.rcs.accounts.*.authToken",
    configFile: "openclaw.json",
    pathPattern: "channels.rcs.accounts.*.authToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.rcs.authToken",
    targetType: "channels.rcs.authToken",
    configFile: "openclaw.json",
    pathPattern: "channels.rcs.authToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

function hasTopLevelRcsAccount(channel: Record<string, unknown>): boolean {
  for (const field of ["accountSid", "messagingServiceSid", "senderId", "defaultTo"]) {
    if (typeof channel[field] === "string" && channel[field].trim().length > 0) {
      return true;
    }
  }
  return false;
}

function hasEnvBackedDefaultRcsAccount(env: NodeJS.ProcessEnv): boolean {
  for (const name of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_RCS_MESSAGING_SERVICE_SID",
    "TWILIO_RCS_SENDER_ID",
  ]) {
    if (typeof env[name] === "string" && env[name].trim().length > 0) {
      return true;
    }
  }
  return false;
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "rcs");
  if (!resolved) {
    return;
  }
  const { channel: rcs, surface } = resolved;
  const hasExplicitDefaultAccount = surface.accounts.some(
    ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
  );
  const topLevelRcsAccountActive =
    (hasTopLevelRcsAccount(rcs) || hasEnvBackedDefaultRcsAccount(params.context.env)) &&
    !hasExplicitDefaultAccount;
  collectConditionalChannelFieldAssignments({
    channelKey: "rcs",
    field: "authToken",
    channel: rcs,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      topLevelRcsAccountActive || (enabled && !hasOwnProperty(account, "authToken")),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled RCS surface inherits this top-level authToken.",
    accountInactiveReason: "RCS account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
