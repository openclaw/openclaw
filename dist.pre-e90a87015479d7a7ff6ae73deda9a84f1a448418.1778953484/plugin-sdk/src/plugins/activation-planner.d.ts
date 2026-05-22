import type { OpenClawConfig } from "../config/types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginManifestActivationCapability } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export type PluginActivationPlannerTrigger = {
    kind: "command";
    command: string;
} | {
    kind: "provider";
    provider: string;
} | {
    kind: "agentHarness";
    runtime: string;
} | {
    kind: "channel";
    channel: string;
} | {
    kind: "route";
    route: string;
} | {
    kind: "capability";
    capability: PluginManifestActivationCapability;
};
export type PluginActivationPlannerHintReason = "activation-agent-harness-hint" | "activation-capability-hint" | "activation-channel-hint" | "activation-command-hint" | "activation-provider-hint" | "activation-route-hint";
export type PluginActivationPlannerManifestReason = "manifest-channel-owner" | "manifest-command-alias" | "manifest-hook-owner" | "manifest-provider-owner" | "manifest-setup-provider-owner" | "manifest-tool-contract";
export type PluginActivationPlannerReason = PluginActivationPlannerHintReason | PluginActivationPlannerManifestReason;
export type PluginActivationPlanEntry = {
    pluginId: string;
    origin: PluginOrigin;
    reasons: readonly PluginActivationPlannerReason[];
};
export type PluginActivationPlan = {
    trigger: PluginActivationPlannerTrigger;
    pluginIds: readonly string[];
    entries: readonly PluginActivationPlanEntry[];
    diagnostics: readonly PluginDiagnostic[];
};
type ResolveManifestActivationPlanParams = {
    trigger: PluginActivationPlannerTrigger;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    origin?: PluginOrigin;
    onlyPluginIds?: readonly string[];
    manifestRecords?: readonly PluginManifestRecord[];
};
export declare function resolveManifestActivationPlan(params: ResolveManifestActivationPlanParams): PluginActivationPlan;
export declare function resolveManifestActivationPluginIds(params: ResolveManifestActivationPlanParams): string[];
export {};
