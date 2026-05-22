import { normalizeFastMode } from "../shared/string-coerce.js";
export { normalizeFastMode };
export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
export type VerboseLevel = "off" | "on" | "full";
export type TraceLevel = "off" | "on" | "raw";
export type NoticeLevel = "off" | "on" | "full";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "tokens" | "full";
export type ThinkingCatalogEntry = {
    provider: string;
    id: string;
    reasoning?: boolean;
    compat?: {
        supportedReasoningEfforts?: readonly string[] | null;
    } | null;
};
export declare const BASE_THINKING_LEVELS: ThinkLevel[];
export declare const THINKING_LEVEL_RANKS: Record<ThinkLevel, number>;
export declare function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined;
export declare function formatXHighModelHint(): string;
export declare function resolveThinkingDefaultForModel(params: {
    provider: string;
    model: string;
    catalog?: ThinkingCatalogEntry[];
}): ThinkLevel;
export declare function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined;
export declare function normalizeTraceLevel(raw?: string | null): TraceLevel | undefined;
export declare function normalizeNoticeLevel(raw?: string | null): NoticeLevel | undefined;
export declare function normalizeUsageDisplay(raw?: string | null): UsageDisplayLevel | undefined;
export declare function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel;
export declare function normalizeElevatedLevel(raw?: string | null): ElevatedLevel | undefined;
export declare function resolveElevatedMode(level?: ElevatedLevel | null): ElevatedMode;
export declare function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined;
