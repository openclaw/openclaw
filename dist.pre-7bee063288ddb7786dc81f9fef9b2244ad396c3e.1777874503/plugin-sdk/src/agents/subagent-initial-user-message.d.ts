/**
 * First user turn for a native `sessions_spawn` / subagent run.
 *
 * Keep the full task out of this message: `buildSubagentSystemPrompt` already
 * places it under **Your Role**, and repeating it here doubles first-request
 * input tokens (#72019).
 */
export declare function buildSubagentInitialUserMessage(params: {
    childDepth: number;
    maxSpawnDepth: number;
    /** When true, this subagent uses a persistent session for follow-up messages. */
    persistentSession: boolean;
}): string;
