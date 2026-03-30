import type { NoticeLevel, ReasoningLevel } from "../thinking.js";
import { type ElevatedLevel, type ThinkLevel, type VerboseLevel } from "../thinking.js";
export declare function extractThinkDirective(body?: string): {
    cleaned: string;
    thinkLevel?: ThinkLevel;
    rawLevel?: string;
    hasDirective: boolean;
};
export declare function extractVerboseDirective(body?: string): {
    cleaned: string;
    verboseLevel?: VerboseLevel;
    rawLevel?: string;
    hasDirective: boolean;
};
export declare function extractNoticeDirective(body?: string): {
    cleaned: string;
    noticeLevel?: NoticeLevel;
    rawLevel?: string;
    hasDirective: boolean;
};
export declare function extractElevatedDirective(body?: string): {
    cleaned: string;
    elevatedLevel?: ElevatedLevel;
    rawLevel?: string;
    hasDirective: boolean;
};
export declare function extractReasoningDirective(body?: string): {
    cleaned: string;
    reasoningLevel?: ReasoningLevel;
    rawLevel?: string;
    hasDirective: boolean;
};
export declare function extractStatusDirective(body?: string): {
    cleaned: string;
    hasDirective: boolean;
};
export type { ElevatedLevel, NoticeLevel, ReasoningLevel, ThinkLevel, VerboseLevel };
export { extractExecDirective } from "./exec/directive.js";
