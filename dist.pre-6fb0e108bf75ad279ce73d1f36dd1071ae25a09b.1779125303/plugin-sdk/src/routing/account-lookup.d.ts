export declare function resolveAccountEntry<T>(accounts: Record<string, T> | undefined, accountId: string): T | undefined;
export declare function resolveNormalizedAccountEntry<T>(accounts: Record<string, T> | undefined, accountId: string, normalizeAccountId: (accountId: string) => string): T | undefined;
