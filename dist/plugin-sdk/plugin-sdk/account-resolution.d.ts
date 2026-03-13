export declare function resolveAccountWithDefaultFallback<TAccount>(params: {
    accountId?: string | null;
    normalizeAccountId: (accountId?: string | null) => string;
    resolvePrimary: (accountId: string) => TAccount;
    hasCredential: (account: TAccount) => boolean;
    resolveDefaultAccountId: () => string;
}): TAccount;
export declare function listConfiguredAccountIds(params: {
    accounts: Record<string, unknown> | undefined;
    normalizeAccountId: (accountId: string) => string;
}): string[];
