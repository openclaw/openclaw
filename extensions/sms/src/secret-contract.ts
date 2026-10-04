import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretContract,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const DEFAULT_ACCOUNT_ID = "default";

function hasTopLevelSmsAccount(channel: Record<string, unknown>): boolean {
  for (const field of ["accountSid", "fromNumber", "messagingServiceSid", "defaultTo"]) {
    if (typeof channel[field] === "string" && channel[field].trim().length > 0) {
      return true;
    }
  }
  return false;
}

function hasEnvBackedDefaultSmsAccount(env: NodeJS.ProcessEnv): boolean {
  for (const name of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_SMS_FROM",
    "TWILIO_MESSAGING_SERVICE_SID",
  ]) {
    if (typeof env[name] === "string" && env[name].trim().length > 0) {
      return true;
    }
  }
  return false;
}

export const channelSecrets = createChannelSecretContract({
  channelKey: "sms",
  account: ["authToken"],
  channel: ["authToken"],
  collect(params) {
    const { channel: sms, surface } = params;
    const hasExplicitDefaultAccount = surface.accounts.some(
      ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
    );
    const topLevelSmsAccountActive =
      (hasTopLevelSmsAccount(sms) || hasEnvBackedDefaultSmsAccount(params.context.env)) &&
      !hasExplicitDefaultAccount;
    collectConditionalChannelFieldAssignments({
      ...params,
      field: "authToken",
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        topLevelSmsAccountActive || (enabled && !hasOwnProperty(account, "authToken")),
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: "no enabled SMS surface inherits this top-level authToken.",
      accountInactiveReason: "SMS account is disabled.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
