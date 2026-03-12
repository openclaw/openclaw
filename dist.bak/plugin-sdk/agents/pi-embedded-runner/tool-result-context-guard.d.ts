export declare const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
export declare const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER = "[compacted: tool output removed to free context]";
type GuardableAgent = object;
export declare function installToolResultContextGuard(params: {
    agent: GuardableAgent;
    contextWindowTokens: number;
}): () => void;
export {};
