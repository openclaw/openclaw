import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
export declare function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult>;
export declare function runPreparedCliAgent(context: PreparedCliRunContext): Promise<EmbeddedPiRunResult>;
export type RunClaudeCliAgentParams = Omit<RunCliAgentParams, "provider" | "cliSessionId"> & {
    provider?: string;
    claudeSessionId?: string;
};
export declare function buildRunClaudeCliAgentParams(params: RunClaudeCliAgentParams): RunCliAgentParams;
export declare function runClaudeCliAgent(params: RunClaudeCliAgentParams): Promise<EmbeddedPiRunResult>;
