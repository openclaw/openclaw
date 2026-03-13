export type ExplicitElevatedAllowField = "id" | "from" | "e164" | "name" | "username" | "tag";
export type AllowFromFormatter = (values: string[]) => string[];
export declare function stripSenderPrefix(value?: string): string;
export declare function parseExplicitElevatedAllowEntry(entry: string): {
    field: ExplicitElevatedAllowField;
    value: string;
} | null;
export declare function addFormattedTokens(params: {
    formatAllowFrom: AllowFromFormatter;
    values: string[];
    tokens: Set<string>;
}): void;
export declare function matchesFormattedTokens(params: {
    formatAllowFrom: AllowFromFormatter;
    value: string;
    includeStripped?: boolean;
    tokens: Set<string>;
}): boolean;
export declare function buildMutableTokens(value?: string): Set<string>;
export declare function matchesMutableTokens(value: string, tokens: Set<string>): boolean;
