//#region src/plugin-sdk/account-core.d.ts
/** Resolve an account by id, then fall back to the default account when the primary lacks credentials. */
declare function resolveAccountWithDefaultFallback<TAccount>(params: {
  accountId?: string | null;
  normalizeAccountId: (accountId?: string | null) => string;
  resolvePrimary: (accountId: string) => TAccount;
  hasCredential: (account: TAccount) => boolean;
  resolveDefaultAccountId: () => string;
}): TAccount;
//#endregion
export { resolveAccountWithDefaultFallback as t };