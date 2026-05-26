//#region src/routing/account-lookup.d.ts
declare function resolveAccountEntry<T>(accounts: Record<string, T> | undefined, accountId: string): T | undefined;
declare function resolveNormalizedAccountEntry<T>(accounts: Record<string, T> | undefined, accountId: string, normalizeAccountId: (accountId: string) => string): T | undefined;
//#endregion
export { resolveNormalizedAccountEntry as n, resolveAccountEntry as t };