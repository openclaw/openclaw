export type { OpenClawConfig } from "../config/config.js";
export { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
export { createAccountListHelpers, describeAccountSnapshot, listCombinedAccountIds, mergeAccountConfig, resolveListedDefaultAccountId, resolveMergedAccountConfig, } from "../channels/plugins/account-helpers.js";
export { normalizeChatType } from "../channels/chat-type.js";
export { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId, } from "../routing/session-key.js";
export { normalizeE164, pathExists, resolveUserPath } from "../utils.js";
export { listConfiguredAccountIds } from "./account-configured-ids.js";
/** Resolve an account by id, then fall back to the default account when the primary lacks credentials. */
export declare function resolveAccountWithDefaultFallback<TAccount>(params: {
    accountId?: string | null;
    normalizeAccountId: (accountId?: string | null) => string;
    resolvePrimary: (accountId: string) => TAccount;
    hasCredential: (account: TAccount) => boolean;
    resolveDefaultAccountId: () => string;
}): TAccount;
