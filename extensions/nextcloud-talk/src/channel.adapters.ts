import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  inspectNextcloudTalkAccount,
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { normalizeNextcloudTalkAllowEntry } from "./policy.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedNextcloudTalkAccount,
  ResolvedNextcloudTalkAccount,
  CoreConfig
>({
  sectionKey: "nextcloud-talk",
  listAccountIds: listNextcloudTalkAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
  inspectAccount: (cfg, accountId) => {
    const account = inspectNextcloudTalkAccount({ cfg, accountId });
    // Diagnostics expose presence only; operational callers retain the actual server URL.
    return { ...account, baseUrl: account.baseUrl ? "[set]" : "[missing]" };
  },
  defaultAccountId: resolveDefaultNextcloudTalkAccountId,
  clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({
      allowFrom,
      stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i,
    }),
});

export const nextcloudTalkSecurityAdapter = {
  resolveDmPolicy: createScopedDmSecurityResolver<ResolvedNextcloudTalkAccount>({
    channelKey: "nextcloud-talk",
    resolvePolicy: (account) => account.config.dmPolicy,
    resolveAllowFrom: (account) => account.config.allowFrom,
    policyPathSuffix: "dmPolicy",
    normalizeEntry: normalizeNextcloudTalkAllowEntry,
  }),
};

export const nextcloudTalkPairingTextAdapter = {
  idLabel: "nextcloudUserId",
  message: "OpenClaw: your access has been approved.",
  normalizeAllowEntry: normalizeNextcloudTalkAllowEntry,
};
