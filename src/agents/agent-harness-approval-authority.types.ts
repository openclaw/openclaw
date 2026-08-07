import type { PluginApprovalResolution } from "../plugins/hook-before-tool-call-result.js";
import type {
  DeferredPluginToolApproval,
  HookContext,
  HookOutcome,
} from "./agent-tools.before-tool-call.types.js";

export type AgentHarnessPluginApprovalResult = {
  id?: string;
  decision?: PluginApprovalResolution | null;
};

export type AgentHarnessPluginApprovalRequest = {
  pluginId: string;
  title: string;
  description: string;
  severity: "info" | "warning";
  toolName: string;
  toolCallId?: string;
  timeoutMs: number;
  gatewayTimeoutMs: number;
  allowedDecisions?: PluginApprovalResolution[];
};

export type AgentHarnessBeforeToolCallApprovalRequest = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  approvalMode?: "request" | "defer" | "report";
  signal?: AbortSignal;
  ctx: HookContext;
};

export type AgentHarnessApprovalOperations = {
  requestPluginApproval: (
    request: AgentHarnessPluginApprovalRequest,
  ) => Promise<AgentHarnessPluginApprovalResult | undefined>;
  waitForPluginApprovalDecision: (request: {
    approvalId: string;
    gatewayTimeoutMs: number;
  }) => Promise<AgentHarnessPluginApprovalResult | null | undefined>;
  runBeforeToolCallApproval: (
    request: AgentHarnessBeforeToolCallApprovalRequest,
  ) => Promise<HookOutcome>;
};

export type NativeHookRelayApprovalAuthority = AgentHarnessApprovalOperations & {
  resolveDeferredToolApproval: (request: {
    deferredApproval: DeferredPluginToolApproval;
    signal?: AbortSignal;
  }) => Promise<HookOutcome>;
};
