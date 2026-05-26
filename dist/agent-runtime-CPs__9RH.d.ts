import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { d as ToolExecutorRef, m as ToolPlanEntry, o as ToolAvailabilityContext, p as ToolPlan, r as JsonObject, s as ToolAvailabilityDiagnostic, t as BuildToolPlanOptions, u as ToolDescriptor } from "./types-Cncbh-d7.js";
//#region src/agents/identity-avatar.d.ts
type AgentAvatarResolution = {
  kind: "none";
  reason: string;
  source?: string;
} | {
  kind: "local";
  filePath: string;
  source: string;
} | {
  kind: "remote";
  url: string;
  source: string;
} | {
  kind: "data";
  url: string;
  source: string;
};
type AgentAvatarPublicSourceInput = {
  kind: AgentAvatarResolution["kind"];
  source?: string | null;
};
declare function resolvePublicAgentAvatarSource(resolved: AgentAvatarPublicSourceInput): string | undefined;
declare function resolveAgentAvatar(cfg: OpenClawConfig, agentId: string, opts?: {
  includeUiOverride?: boolean;
}): AgentAvatarResolution;
//#endregion
//#region src/agents/auth-profiles/path-resolve.d.ts
declare function resolveAuthStorePathForDisplay(agentDir?: string): string;
//#endregion
//#region src/agents/model-catalog-scope.d.ts
declare function resolveModelCatalogScope(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): {
  providerRefs: string[];
  modelRefs: string[];
};
declare function resolveProviderDiscoveryProviderIdsForCatalogScope(params: {
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
}): string[] | undefined;
//#endregion
//#region src/tools/availability.d.ts
declare function evaluateToolAvailability(params: {
  descriptor: ToolDescriptor;
  context?: ToolAvailabilityContext;
}): readonly ToolAvailabilityDiagnostic[];
//#endregion
//#region src/tools/descriptors.d.ts
declare function defineToolDescriptor(descriptor: ToolDescriptor): ToolDescriptor;
declare function defineToolDescriptors(descriptors: readonly ToolDescriptor[]): readonly ToolDescriptor[];
//#endregion
//#region src/tools/diagnostics.d.ts
type ToolPlanContractErrorCode = "duplicate-tool-name" | "missing-executor";
declare class ToolPlanContractError extends Error {
  readonly code: ToolPlanContractErrorCode;
  readonly toolName: string;
  constructor(params: {
    code: ToolPlanContractErrorCode;
    toolName: string;
    message: string;
  });
}
//#endregion
//#region src/tools/execution.d.ts
declare function formatToolExecutorRef(ref: ToolExecutorRef): string;
//#endregion
//#region src/tools/planner.d.ts
declare function buildToolPlan(options: BuildToolPlanOptions): ToolPlan;
//#endregion
//#region src/tools/protocol.d.ts
type ToolProtocolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
};
declare function toToolProtocolDescriptor(entry: ToolPlanEntry): ToolProtocolDescriptor;
declare function toToolProtocolDescriptors(entries: readonly ToolPlanEntry[]): readonly ToolProtocolDescriptor[];
//#endregion
export { ToolPlanContractError as a, evaluateToolAvailability as c, resolveAuthStorePathForDisplay as d, AgentAvatarResolution as f, formatToolExecutorRef as i, resolveModelCatalogScope as l, resolvePublicAgentAvatarSource as m, toToolProtocolDescriptors as n, defineToolDescriptor as o, resolveAgentAvatar as p, buildToolPlan as r, defineToolDescriptors as s, toToolProtocolDescriptor as t, resolveProviderDiscoveryProviderIdsForCatalogScope as u };