// Narrow surface used by host contract / audit / doctor checks.
//
// Mirrors `openclaw/extensions/feishu/contract-api.ts` so cross-cutting
// host code that wants to reach into a channel without booting the full
// runtime can do so via this stable barrel.

export {
  resolveDingtalkAccount,
  listDingtalkAccountIds,
  resolveDefaultDingtalkAccountId,
  resolveDingtalkCredentials,
} from "./src/config/accounts.js";

export {
  normalizeDingtalkTarget,
  formatDingtalkTarget,
  looksLikeDingtalkId,
} from "./src/targets.js";

export const dingtalkSessionBindingAdapterChannels = ["dingtalk"] as const;
