import { type ThinkLevel } from "../../auto-reply/thinking.js";
export declare function pickFallbackThinkingLevel(params: {
    message?: string;
    attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined;
