import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry.js";
import { analyzeCommandSecretAssignmentsFromSnapshot } from "../secrets/command-config.js";
import { collectConfigAssignments } from "../secrets/runtime-config-collectors.js";
import { resolveRuntimeWebTools } from "../secrets/runtime-web-tools.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
type ResolveCommandSecretsResult = {
    resolvedConfig: OpenClawConfig;
    diagnostics: string[];
    targetStatesByPath: Record<string, CommandSecretTargetState>;
    hadUnresolvedTargets: boolean;
};
export type CommandSecretResolutionMode = "enforce_resolved" | "read_only_status" | "read_only_operational";
type LegacyCommandSecretResolutionMode = "strict" | "summary" | "operational_readonly";
type CommandSecretResolutionModeInput = CommandSecretResolutionMode | LegacyCommandSecretResolutionMode;
type CommandSecretTargetState = "resolved_gateway" | "resolved_local" | "inactive_surface" | "unresolved";
type CommandSecretGatewayDeps = {
    analyzeCommandSecretAssignmentsFromSnapshot: typeof analyzeCommandSecretAssignmentsFromSnapshot;
    collectConfigAssignments: typeof collectConfigAssignments;
    discoverConfigSecretTargetsByIds: typeof discoverConfigSecretTargetsByIds;
    resolveManifestContractOwnerPluginId: typeof resolveManifestContractOwnerPluginId;
    resolveRuntimeWebTools: typeof resolveRuntimeWebTools;
};
export declare const __testing: {
    setDepsForTest(overrides: Partial<CommandSecretGatewayDeps>): () => void;
    resetDepsForTest(): void;
};
export declare function resolveCommandSecretRefsViaGateway(params: {
    config: OpenClawConfig;
    commandName: string;
    targetIds: Set<string>;
    mode?: CommandSecretResolutionModeInput;
    allowedPaths?: ReadonlySet<string>;
}): Promise<ResolveCommandSecretsResult>;
export {};
