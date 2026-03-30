import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
export declare function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel;
export declare function describeUnknownError(error: unknown): string;
export type { ReasoningLevel, ThinkLevel };
