export type AgentStreamParams = {
    /** Provider stream params override (best-effort). */
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    /** Provider fast-mode override (best-effort). */
    fastMode?: boolean;
};
export type ClientToolDefinition = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        /** Strict argument enforcement (Responses API). Propagated from the request. */
        strict?: boolean;
    };
};
