import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const fields = ["clientSecret", "refreshToken", "bearerToken"] as const;
export const channelSecrets = createChannelSecretContract({
  channelKey: "x",
  account: [...fields],
  channel: [...fields],
  collect(params) {
    for (const field of fields) {
      collectSimpleChannelFieldAssignments({
        ...params,
        field,
        topInactiveReason: `no enabled X account inherits this top-level ${field}.`,
        accountInactiveReason: "X account is disabled.",
      });
    }
  },
});
