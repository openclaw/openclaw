type SlackCursorResponse = {
    response_metadata?: {
        next_cursor?: string;
    };
};
export declare function collectSlackCursorItems<TItem, TResponse extends SlackCursorResponse>(params: {
    fetchPage: (cursor?: string) => Promise<TResponse>;
    collectPageItems: (response: TResponse) => TItem[];
}): Promise<TItem[]>;
export declare function resolveSlackAllowlistEntries<TParsed extends {
    id?: string;
}, TLookup, TResult>(params: {
    entries: string[];
    lookup: TLookup[];
    parseInput: (input: string) => TParsed;
    findById: (lookup: TLookup[], id: string) => TLookup | undefined;
    buildIdResolved: (params: {
        input: string;
        parsed: TParsed;
        match?: TLookup;
    }) => TResult;
    resolveNonId: (params: {
        input: string;
        parsed: TParsed;
        lookup: TLookup[];
    }) => TResult | undefined;
    buildUnresolved: (input: string) => TResult;
}): TResult[];
export {};
