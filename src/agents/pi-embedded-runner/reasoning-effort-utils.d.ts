import type { ThinkLevel } from "../../auto-reply/thinking.js";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export declare function mapThinkingLevelToReasoningEffort(thinkingLevel: ThinkLevel): ReasoningEffort;
