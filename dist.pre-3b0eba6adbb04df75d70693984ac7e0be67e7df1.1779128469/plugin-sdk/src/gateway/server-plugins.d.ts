import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { ErrorShape } from "./protocol/index.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
export declare function setFallbackGatewayContext(ctx: GatewayRequestContext): () => void;
export declare function setFallbackGatewayContextResolver(resolveContext: () => GatewayRequestContext | undefined): () => void;
export declare function clearFallbackGatewayContext(): void;
export declare function setPluginSubagentOverridePolicies(cfg: OpenClawConfig): void;
type DispatchGatewayMethodInProcessOptions = {
    allowSyntheticModelOverride?: boolean;
    disableSyntheticClient?: boolean;
    expectFinal?: boolean;
    forceSyntheticClient?: boolean;
    pluginRuntimeOwnerId?: string;
    requireScopedClient?: boolean;
    syntheticScopes?: string[];
    timeoutMs?: number;
};
export type GatewayMethodDispatchResponse = {
    ok: boolean;
    payload?: unknown;
    error?: ErrorShape;
    meta?: Record<string, unknown>;
};
export declare function dispatchGatewayMethodInProcessRaw(method: string, params: unknown, options?: DispatchGatewayMethodInProcessOptions): Promise<GatewayMethodDispatchResponse>;
export declare function dispatchGatewayMethodInProcess<T>(method: string, params: Record<string, unknown>, options?: DispatchGatewayMethodInProcessOptions): Promise<T>;
export declare function createGatewaySubagentRuntime(): PluginRuntime["subagent"];
export declare function createGatewayNodesRuntime(): PluginRuntime["nodes"];
export declare function loadGatewayPlugins(params: {
    cfg: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    autoEnabledReasons?: Readonly<Record<string, string[]>>;
    workspaceDir: string;
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
        debug: (msg: string) => void;
    };
    coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
    coreGatewayMethodNames?: readonly string[];
    hostServices?: PluginRegistryParams["hostServices"];
    baseMethods: string[];
    pluginIds?: string[];
    pluginLookUpTable?: PluginLookUpTable;
    preferSetupRuntimeForChannelPlugins?: boolean;
    suppressPluginInfoLogs?: boolean;
    startupTrace?: {
        detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
    };
}): {
    pluginRegistry: import("../plugins/registry-types.js").PluginRegistry;
    gatewayMethods: string[];
};
export {};
