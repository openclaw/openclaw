type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only";
type ArgSplitQuoteChar = '"' | "'";
type ArgSplitQuoteStart = "anywhere" | "item-start";
export declare function splitArgsPreservingQuotes(value: string, options?: {
    escapeMode?: ArgSplitEscapeMode;
    quoteChars?: readonly ArgSplitQuoteChar[];
    quoteStart?: ArgSplitQuoteStart;
}): string[];
export {};
