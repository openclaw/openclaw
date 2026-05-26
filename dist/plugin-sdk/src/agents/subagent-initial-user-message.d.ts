/**
 * First user turn for a native `sessions_spawn` / subagent run.
 *
 * Keep the delegated task transcript-visible and single-sourced here. The
 * system prompt owns runtime/subagent rules; this user turn owns the actual
 * task envelope so delivery is easy to audit without duplicating tokens.
 */
export declare function buildSubagentInitialUserMessage(params: {
    childDepth: number;
    maxSpawnDepth: number;
    /** When true, this subagent uses a persistent session for follow-up messages. */
    persistentSession: boolean;
    task?: string;
}): string;
