import type { ContextEngine, ContextEngineHostCapability, ContextEngineHostRequirements, ContextEngineInfo, ContextEngineOperation } from "./types.js";
export type ContextEngineHostSupport = {
    id: string;
    label: string;
    capabilities: readonly ContextEngineHostCapability[];
};
export declare const GENERIC_CLI_CONTEXT_ENGINE_HOST_CAPABILITIES: readonly ["bootstrap", "after-turn", "maintain"];
export declare const PI_EMBEDDED_CONTEXT_ENGINE_HOST: {
    readonly id: "pi-embedded";
    readonly label: "Pi embedded runner";
    readonly capabilities: readonly ["bootstrap", "assemble-before-prompt", "after-turn", "maintain", "compact", "runtime-llm-complete"];
};
export declare const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST: {
    readonly id: "codex-app-server";
    readonly label: "Codex app-server harness";
    readonly capabilities: readonly ["bootstrap", "assemble-before-prompt", "after-turn", "maintain", "compact", "runtime-llm-complete", "thread-bootstrap-projection"];
};
export type ContextEngineHostSupportEvaluation = {
    ok: true;
    requirements?: ContextEngineHostRequirements;
    missingCapabilities: [];
} | {
    ok: false;
    requirements: ContextEngineHostRequirements;
    missingCapabilities: ContextEngineHostCapability[];
};
/** Build the default host support advertised by the generic CLI runner. */
export declare function buildGenericCliContextEngineHostSupport(params: {
    backendId: string;
    capabilities?: readonly ContextEngineHostCapability[];
}): ContextEngineHostSupport;
/** Evaluate whether a context-engine host can safely run the requested operation. */
export declare function evaluateContextEngineHostSupport(params: {
    contextEngineInfo: ContextEngineInfo;
    operation: ContextEngineOperation;
    host: ContextEngineHostSupport;
}): ContextEngineHostSupportEvaluation;
/** Assert that a context engine can safely run under the supplied host. */
export declare function assertContextEngineHostSupport(params: {
    contextEngine: ContextEngine;
    operation: ContextEngineOperation;
    host: ContextEngineHostSupport;
}): void;
