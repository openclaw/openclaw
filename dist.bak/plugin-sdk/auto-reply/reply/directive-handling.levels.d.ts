import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
export declare function resolveCurrentDirectiveLevels(params: {
    sessionEntry?: {
        thinkingLevel?: unknown;
        verboseLevel?: unknown;
        reasoningLevel?: unknown;
        elevatedLevel?: unknown;
    };
    agentCfg?: {
        thinkingDefault?: unknown;
        verboseDefault?: unknown;
        elevatedDefault?: unknown;
    };
    resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
}): Promise<{
    currentThinkLevel: ThinkLevel | undefined;
    currentVerboseLevel: VerboseLevel | undefined;
    currentReasoningLevel: ReasoningLevel;
    currentElevatedLevel: ElevatedLevel | undefined;
}>;
