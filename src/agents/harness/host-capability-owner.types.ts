import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type {
  AgentHarnessHostCapabilities,
  AgentHarnessHostCapabilitiesV2,
} from "./host-capability-types.js";

type AgentHarnessHostAttempt = Partial<EmbeddedRunAttemptInternalParams> &
  Pick<EmbeddedRunAttemptInternalParams, "admittedRunContext" | "runId">;
export type AgentHarnessHostApprovalResult = NonNullable<
  Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>
>;
export type HostToolSurfaceOptions = Parameters<
  NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
>[0];

export type HostCapabilities = AgentHarnessHostCapabilities | AgentHarnessHostCapabilitiesV2;
export type HostCapabilityOptions = {
  attempt: AgentHarnessHostAttempt;
  pluginId: string;
  requiredNodeCommands?: readonly string[];
  nativeModelPolicySupport?: "exact";
  toolCalls?: "deny";
};
export type HostCapabilityOwner<Version extends 1 | 2> = {
  capabilities: Version extends 2 ? AgentHarnessHostCapabilitiesV2 : AgentHarnessHostCapabilities;
  close: () => void;
  setInputAttachmentReadAllowed: (allowed: boolean) => void;
  runWithScope: <T>(run: () => Promise<T>) => Promise<T>;
};
