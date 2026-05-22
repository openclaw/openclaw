/** List normalized configured account ids from a raw channel account record map. */
export declare function listConfiguredAccountIds(params: {
    accounts: Record<string, unknown> | undefined;
    normalizeAccountId: (accountId: string) => string;
}): string[];
