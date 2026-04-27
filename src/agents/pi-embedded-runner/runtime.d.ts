export type EmbeddedAgentRuntime = "pi" | "auto" | (string & {});
export type EmbeddedAgentHarnessFallback = "pi" | "none";
export declare function normalizeEmbeddedAgentRuntime(raw: string | undefined): EmbeddedAgentRuntime;
export declare function resolveEmbeddedAgentRuntime(env?: NodeJS.ProcessEnv): EmbeddedAgentRuntime;
export declare function resolveEmbeddedAgentHarnessFallback(env?: NodeJS.ProcessEnv): EmbeddedAgentHarnessFallback | undefined;
