import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
export type EmbeddedAgentSessionOptions = {
    cwd: string;
    agentDir: string;
    authStorage: unknown;
    modelRegistry: unknown;
    model: unknown;
    thinkingLevel: unknown;
    tools: NonNullable<CreateAgentSessionOptions["tools"]>;
    customTools: NonNullable<CreateAgentSessionOptions["customTools"]>;
    sessionManager: unknown;
    settingsManager: unknown;
    resourceLoader: unknown;
};
export declare function createEmbeddedAgentSessionWithResourceLoader<Result>(params: {
    createAgentSession: (options: EmbeddedAgentSessionOptions) => Promise<Result> | Result;
    options: EmbeddedAgentSessionOptions;
}): Promise<Result>;
