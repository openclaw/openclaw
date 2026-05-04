import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listMaxAccountIds,
  resolveDefaultMaxAccountId,
  resolveMaxAccount,
} from "../account-resolver.js";
import type { CoreConfig, ResolvedMaxAccount } from "../types.js";

/**
 * Account-scoped config adapter for `channels.max-messenger`.
 *
 * The shape mirrors `nextcloudTalkConfigAdapter`
 * (extensions/nextcloud-talk/src/channel.adapters.ts:17). Allowlist formatters
 * stay simple in Phase 1A and grow alongside the polling supervisor in 1B.
 */
export const maxMessengerConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMaxAccount,
  ResolvedMaxAccount,
  CoreConfig
>({
  sectionKey: "max-messenger",
  listAccountIds: listMaxAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMaxAccount),
  defaultAccountId: resolveDefaultMaxAccountId,
  clearBaseFields: ["token", "tokenFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
});
