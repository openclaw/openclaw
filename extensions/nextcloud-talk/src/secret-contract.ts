import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { hasConfiguredNextcloudAccount } from "../configured-state.js";

export const channelSecrets = createChannelSecretContract({
  channelKey: "nextcloud-talk",
  account: ["apiPassword", "botSecret"],
  channel: ["apiPassword", "botSecret"],
  hasImplicitDefaultAccount: ({ context }) =>
    hasConfiguredNextcloudAccount(context.sourceConfig.channels?.["nextcloud-talk"], context.env),
  collect(params) {
    // Runtime collection historically reports botSecret before apiPassword.
    for (const field of ["botSecret", "apiPassword"]) {
      collectSimpleChannelFieldAssignments({
        ...params,
        field,
        topInactiveReason: `no enabled Nextcloud Talk surface inherits this top-level ${field}.`,
        accountInactiveReason: "Nextcloud Talk account is disabled.",
      });
    }
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
