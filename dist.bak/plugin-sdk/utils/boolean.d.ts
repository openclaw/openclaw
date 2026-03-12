export type BooleanParseOptions = {
    truthy?: string[];
    falsy?: string[];
};
export declare function parseBooleanValue(value: unknown, options?: BooleanParseOptions): boolean | undefined;
