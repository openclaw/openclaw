import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import { createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime } from "../../gateway/mcp-http.loopback-runtime.js";
import type { CliBackendAuthEpochMode, CliBackendPreparedExecution } from "../../plugins/cli-backend.types.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { makeBootstrapWarn as makeBootstrapWarnImpl, resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl } from "../bootstrap-files.js";
import { claudeCliSessionTranscriptHasContent } from "../command/attempt-execution.helpers.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";
declare const prepareDeps: {
    makeBootstrapWarn: typeof makeBootstrapWarnImpl;
    resolveBootstrapContextForRun: typeof resolveBootstrapContextForRunImpl;
    getActiveMcpLoopbackRuntime: typeof getActiveMcpLoopbackRuntime;
    ensureMcpLoopbackServer: typeof ensureMcpLoopbackServer;
    createMcpLoopbackServerConfig: typeof createMcpLoopbackServerConfig;
    resolveOpenClawReferencePaths: (params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0]) => Promise<{
        docsPath: string | null;
        sourcePath: string | null;
    }>;
    claudeCliSessionTranscriptHasContent: typeof claudeCliSessionTranscriptHasContent;
};
export declare function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void;
export declare function shouldSkipLocalCliCredentialEpoch(params: {
    authEpochMode?: CliBackendAuthEpochMode;
    authProfileId?: string;
    authCredential?: AuthProfileCredential;
    preparedExecution?: CliBackendPreparedExecution | null;
}): boolean;
export declare function prepareCliRunContext(params: RunCliAgentParams): Promise<PreparedCliRunContext>;
export {};
