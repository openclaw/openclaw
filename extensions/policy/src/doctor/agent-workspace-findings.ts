import type { HealthFinding } from "openclaw/plugin-sdk/health";
import type { PolicyAgentWorkspaceEvidence, PolicyEvidence } from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import { policyEvidenceFinding } from "./policy-evidence-finding.js";
import { scopedAgentEvidenceMatches } from "./policy-scope.js";
import { policySectionTargets } from "./policy-section-targets.js";
import { readStringList } from "./utils.js";

export function agentWorkspaceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const entries = evidence.agentWorkspace ?? [];
  const findings: HealthFinding[] = [];
  for (const target of policySectionTargets(
    policy,
    policyPath,
    policyDocName,
    "agents/workspace",
  )) {
    const agentId = target.selectorId;
    findings.push(
      ...workspaceFindings(
        target.policy,
        policyDocName,
        target.requirementBase,
        agentId === undefined
          ? entries
          : entries.filter((entry) =>
              scopedAgentEvidenceMatches(entry, agentId, entries, entry.scope === "defaults"),
            ),
      ),
    );
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
