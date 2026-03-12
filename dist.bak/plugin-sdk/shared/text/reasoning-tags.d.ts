export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";
export declare function stripReasoningTagsFromText(text: string, options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
}): string;
