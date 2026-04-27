export declare const SUBAGENT_SPAWN_MODES: readonly ["run", "session"];
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];
export declare const SUBAGENT_SPAWN_SANDBOX_MODES: readonly ["inherit", "require"];
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];
export declare const SUBAGENT_SPAWN_CONTEXT_MODES: readonly ["isolated", "fork"];
export type SpawnSubagentContextMode = (typeof SUBAGENT_SPAWN_CONTEXT_MODES)[number];
