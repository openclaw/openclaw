// Policy doctor health-check catalog.
import type { HealthCheck, HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import type { POLICY_CHECK_IDS } from "./metadata.js";
import type { PolicyEvaluation } from "./register.js";
import { createPolicyChannelProviderChecks, createPolicyIngressChecks } from "./scopes/channels.js";
import { createPolicyCoreChecks } from "./scopes/core.js";
import { createPolicyDataAuthChecks } from "./scopes/data-auth.js";
import { createPolicyExecApprovalChecks } from "./scopes/exec-approvals.js";
import { createPolicyGatewayChecks } from "./scopes/gateway.js";
import { createPolicyModelNetworkChecks } from "./scopes/model-network.js";
import { createPolicySandboxChecks } from "./scopes/sandbox.js";
import { createPolicyAgentToolChecks, createPolicyToolMetadataChecks } from "./scopes/tools.js";

export type PolicyDoctorCheckDeps = {
  readonly evaluatePolicy: (ctx: HealthCheckContext) => Promise<PolicyEvaluation>;
  readonly findingsForCheck: (
    evaluation: PolicyEvaluation,
    checkId: (typeof POLICY_CHECK_IDS)[number],
  ) => readonly HealthFinding[];
  readonly workspaceRepairsEnabled: (ctx: HealthCheckContext) => boolean;
  readonly workspaceRepairsDisabledResult: (fileName: string) => {
    readonly status: "skipped";
    readonly reason: string;
    readonly changes: readonly string[];
  };
  readonly channelIdsFromFindings: (findings: readonly HealthFinding[]) => readonly string[];
  readonly disableChannels: (
    cfg: HealthCheckContext["cfg"],
    channelIds: readonly string[],
  ) => { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] };
};

export function createPolicyDoctorChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return [
    ...createPolicyCoreChecks(deps),
    ...createPolicyChannelProviderChecks(deps),
    ...createPolicyModelNetworkChecks(deps),
    ...createPolicyIngressChecks(deps),
    ...createPolicyGatewayChecks(deps),
    ...createPolicyAgentToolChecks(deps),
    ...createPolicySandboxChecks(deps),
    ...createPolicyDataAuthChecks(deps),
    ...createPolicyExecApprovalChecks(deps),
    ...createPolicyToolMetadataChecks(deps),
  ];
}
