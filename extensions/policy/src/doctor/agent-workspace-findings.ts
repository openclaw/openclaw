import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyAgentWorkspaceEvidence, PolicyEvidence } from "../policy-state.js";
import { getPolicyPath } from "../policy-value.js";
import { CHECK_IDS } from "./check-ids.js";
import { policyEvidenceFinding } from "./policy-evidence-finding.js";
import { agentScopedPolicyTargets, scopedAgentEvidenceMatches } from "./policy-scope.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readStringList } from "./utils.js";

export function agentWorkspaceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (
    posturePolicyShapeFinding("agents", isRecord(policy) ? policy.agents : undefined, {
      policyDocName,
      policyPath,
    }) !== undefined
  ) {
    return [];
  }
  const entries = evidence.agentWorkspace ?? [];
  const findings = workspaceFindings(
    getPolicyPath(policy, ["agents", "workspace"]),
    policyDocName,
    "agents/workspace",
    entries,
  );
  if (hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    for (const target of agentScopedPolicyTargets(policy)) {
      findings.push(
        ...workspaceFindings(
          getPolicyPath(target.overlay, ["agents", "workspace"]),
          policyDocName,
          `scopes/${ocPathSegment(target.scopeName)}/agents/workspace`,
          entries.filter((entry) =>
            scopedAgentEvidenceMatches(entry, target.agentId, entries, entry.scope === "defaults"),
          ),
        ),
      );
    }
  }
  return findings;
}

function workspaceFindings(
  workspace: unknown,
  policyDocName: string,
  requirementBase: string,
  entries: readonly PolicyAgentWorkspaceEvidence[],
): HealthFinding[] {
  const allowed = new Set(readStringList(workspace, ["allowedAccess"]));
  const requiredDeniedTools = new Set(readStringList(workspace, ["denyTools"]));
  return [
    ...entries
      .filter(
        (entry) =>
          allowed.size > 0 &&
          entry.kind === "workspaceAccess" &&
          entry.value !== undefined &&
          (entry.sandboxEnabled !== true || !allowed.has(entry.value)),
      )
      .map((entry) => {
        const sandboxDisabled = entry.sandboxEnabled !== true;
        const observed = sandboxDisabled
          ? `sandbox mode '${entry.sandboxMode ?? "off"}'`
          : `sandbox workspaceAccess '${entry.value ?? ""}'`;
        const source = sandboxDisabled ? (entry.sandboxModeSource ?? entry.source) : entry.source;
        return policyEvidenceFinding(
          { source },
          {
            checkId: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
            message: `${workspaceLabel(entry)} ${observed} is not allowed by policy.`,
            requirement: `oc://${policyDocName}/${requirementBase}/allowedAccess`,
            fixHint:
              "Enable sandbox mode with workspaceAccess none/ro or update policy after review.",
          },
        );
      }),
    ...entries
      .filter(
        (entry) =>
          entry.kind === "toolDeny" &&
          entry.tool !== undefined &&
          requiredDeniedTools.has(entry.tool) &&
          entry.denied !== true,
      )
      .map((entry) =>
        policyEvidenceFinding(entry, {
          checkId: CHECK_IDS.policyAgentsToolNotDenied,
          message: `${workspaceLabel(entry)} does not deny required tool '${entry.tool ?? ""}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/denyTools`,
          fixHint:
            "Add the tool to tools.deny or agents.entries.<id>.tools.deny, or update policy after review.",
        }),
      ),
  ];
}

function workspaceLabel(entry: PolicyAgentWorkspaceEvidence): string {
  return entry.agentId === undefined ? "agents.defaults" : `agent '${entry.agentId}'`;
}
