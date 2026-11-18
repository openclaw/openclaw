import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  EXEC_APPROVALS_POLICY_DOCUMENT_NAME,
  EXEC_APPROVALS_POLICY_URI,
} from "../exec-approvals-uri.js";
import { parseExecApprovalsFile } from "../policy-state-exec-approvals.js";
import type { PolicyEvidence, PolicyExecApprovalEvidence } from "../policy-state.js";
import { execApprovalsPolicyShapeFinding } from "./access-shapes.js";
import { CHECK_IDS } from "./check-ids.js";
import {
  execApprovalAgentEntries,
  execApprovalAllowlistMissingTarget,
  execApprovalAllowlistRequirementKey,
  formatExecApprovalAllowlistEntry,
  readExecApprovalAllowlistRequirements,
} from "./exec-approval-rules.js";
import { policyEvidenceFinding } from "./policy-evidence-finding.js";
import { agentScopedPolicyTargets } from "./policy-scope.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function execApprovalsFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
  file:
    | { readonly raw: string; readonly displayName: string; readonly ocDocName: string }
    | null
    | undefined,
  displayName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const entries = evidence.execApprovals ?? [];
  const defaults = entries.find((entry) => entry.kind === "defaults");
  const defaultSecurity = defaults?.security ?? "full";

  if (isRecord(policy.execApprovals)) {
    const shapeFinding = execApprovalsPolicyShapeFinding(policy.execApprovals, {
      policyDocName,
      policyPath,
    });
    if (shapeFinding !== undefined) {
      return [shapeFinding];
    }
    const fileFindings = execApprovalsFileFindings(policy.execApprovals, {
      policyDocName,
      file,
      displayName,
      requirementBase: "execApprovals",
    });
    findings.push(...fileFindings);
    if (fileFindings.length > 0) {
      return findings;
    }
    findings.push(
      ...execApprovalsRuleFindings(policy.execApprovals, {
        entries,
        defaultSecurity,
        defaults,
        displayName,
        fileDisplayName: file?.displayName,
        policyDocName,
        requirementBase: "execApprovals",
      }),
    );
  }

  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  const scopedFileFindingScopes = new Set<string>();
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!isRecord(target.overlay.execApprovals)) {
      continue;
    }
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/execApprovals`;
    const fileFindings = execApprovalsFileFindings(target.overlay.execApprovals, {
      policyDocName,
      file,
      displayName,
      requirementBase,
    });
    if (fileFindings.length > 0) {
      if (!scopedFileFindingScopes.has(target.scopeName)) {
        findings.push(...fileFindings);
        scopedFileFindingScopes.add(target.scopeName);
      }
      continue;
    }
    findings.push(
      ...execApprovalsRuleFindings(target.overlay.execApprovals, {
        entries,
        defaultSecurity,
        defaults,
        displayName,
        fileDisplayName: file?.displayName,
        policyDocName,
        requirementBase,
        targetAgentId: target.agentId,
      }),
    );
  }
  return findings;
}

function execApprovalsFileFindings(
  execApprovalsPolicy: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly file:
      | { readonly raw: string; readonly displayName: string; readonly ocDocName: string }
      | null
      | undefined;
    readonly displayName: string;
    readonly requirementBase: string;
  },
): readonly HealthFinding[] {
  const requireFile = readPolicyBoolean(execApprovalsPolicy, ["requireFile"]) === true;
  const needsArtifactEvidence =
    requireFile || execApprovalsPolicyNeedsArtifactEvidence(execApprovalsPolicy);
  if (needsArtifactEvidence && params.file === null) {
    return [
      {
        checkId: CHECK_IDS.policyExecApprovalsMissing,
        severity: "error",
        message: `${EXEC_APPROVALS_POLICY_DOCUMENT_NAME} evidence is required by policy but was not found.`,
        source: "policy",
        path: params.displayName,
        target: EXEC_APPROVALS_POLICY_URI,
        requirement: `oc://${params.policyDocName}/${
          requireFile ? `${params.requirementBase}/requireFile` : params.requirementBase
        }`,
        fixHint: "Restore the approved exec approvals artifact or update policy after review.",
      },
    ];
  }
  if (params.file === null || params.file === undefined) {
    return [];
  }
  const parsed = parseExecApprovalsFile(params.file.raw);
  if (parsed.ok || !needsArtifactEvidence) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyExecApprovalsInvalid,
      severity: "error",
      message: `${params.file.displayName} could not be parsed: ${parsed.message}`,
      source: "policy",
      path: params.file.displayName,
      target: `oc://${params.file.ocDocName}`,
      requirement: `oc://${params.policyDocName}/${params.requirementBase}`,
      fixHint: `Fix ${EXEC_APPROVALS_POLICY_DOCUMENT_NAME} so it is valid JSON.`,
    },
  ];
}

function execApprovalsPolicyNeedsArtifactEvidence(
  execApprovalsPolicy: Record<string, unknown>,
): boolean {
  return isRecord(execApprovalsPolicy.defaults) || isRecord(execApprovalsPolicy.agents);
}

function execApprovalsRuleFindings(
  execApprovalsPolicy: Record<string, unknown>,
  params: {
    readonly entries: readonly PolicyExecApprovalEvidence[];
    readonly defaultSecurity: string;
    readonly defaults?: PolicyExecApprovalEvidence;
    readonly displayName: string;
    readonly fileDisplayName?: string;
    readonly policyDocName: string;
    readonly requirementBase: string;
    readonly targetAgentId?: string;
  },
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  const allowedDefaults = new Set(
    readStringList(execApprovalsPolicy, ["defaults", "allowSecurity"]),
  );
  if (
    params.targetAgentId === undefined &&
    allowedDefaults.size > 0 &&
    !allowedDefaults.has(params.defaultSecurity.toLowerCase())
  ) {
    findings.push(
      execApprovalFinding(params.defaults, {
        checkId: CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
        message: `exec approvals defaults use unapproved security mode '${params.defaultSecurity}'.`,
        requirement: `oc://${params.policyDocName}/${params.requirementBase}/defaults/allowSecurity`,
        fixHint: "Set defaults.security to an approved mode or update policy after review.",
      }),
    );
  }

  const allowedAgents = new Set(readStringList(execApprovalsPolicy, ["agents", "allowSecurity"]));
  if (allowedAgents.size > 0) {
    const agentEntries = execApprovalAgentEntries(
      params.entries,
      params.defaults,
      "security",
      params.targetAgentId,
    );
    for (const entry of agentEntries) {
      const security = entry.security ?? params.defaultSecurity;
      if (allowedAgents.has(security.toLowerCase())) {
        continue;
      }
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
          message: `exec approvals agent '${entry.agentId ?? params.targetAgentId ?? "inherited defaults"}' uses unapproved security mode '${security}'.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowSecurity`,
          fixHint:
            "Set the agent approval security mode to an approved value or update policy after review.",
        }),
      );
    }
  }

  const allowAutoAllowSkills = readPolicyBoolean(execApprovalsPolicy, [
    "agents",
    "allowAutoAllowSkills",
  ]);
  if (allowAutoAllowSkills === false) {
    const autoAllowEntries = execApprovalAgentEntries(
      params.entries,
      params.defaults,
      "autoAllowSkills",
      params.targetAgentId,
    );
    for (const entry of autoAllowEntries) {
      if (entry.autoAllowSkills !== true) {
        continue;
      }
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
          message: `exec approvals agent '${entry.agentId ?? params.targetAgentId ?? "inherited defaults"}' enables autoAllowSkills outside policy.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowAutoAllowSkills`,
          fixHint:
            "Set autoAllowSkills to false or update policy after reviewing implicit skill CLI trust.",
        }),
      );
    }
  }

  const expected = readExecApprovalAllowlistRequirements(execApprovalsPolicy, [
    "agents",
    "allowlist",
    "expected",
  ]);
  if (expected !== undefined) {
    const expectedSet = new Set(expected.map((entry) => entry.key));
    const actual = new Map<string, PolicyExecApprovalEvidence>();
    for (const entry of execApprovalAllowlistEntries(params.entries, params.targetAgentId)) {
      if (entry.pattern === undefined) {
        continue;
      }
      const key = execApprovalAllowlistRequirementKey(entry.pattern, entry.argPattern);
      if (!actual.has(key)) {
        actual.set(key, entry);
      }
    }
    for (const entry of expected.toSorted((a, b) => a.key.localeCompare(b.key))) {
      if (!actual.has(entry.key)) {
        const requirement = `oc://${params.policyDocName}/${params.requirementBase}/agents/allowlist/expected`;
        const target = execApprovalAllowlistMissingTarget(params.targetAgentId);
        findings.push({
          checkId: CHECK_IDS.policyExecApprovalsAllowlistMissing,
          severity: "error",
          message: `exec approvals allowlist is missing expected pattern '${formatExecApprovalAllowlistEntry(entry)}'.`,
          source: "policy",
          path: params.fileDisplayName ?? params.displayName,
          target,
          requirement,
          fixHint: "Add the expected approval pattern or update policy after review.",
        });
      }
    }
    for (const key of [...actual.keys()].toSorted()) {
      if (expectedSet.has(key)) {
        continue;
      }
      const entry = actual.get(key);
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
          message: `exec approvals allowlist has unexpected pattern '${formatExecApprovalAllowlistEntry(entry)}'.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowlist/expected`,
          fixHint: "Remove the unexpected approval pattern or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function execApprovalAllowlistEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string | undefined,
): readonly PolicyExecApprovalEvidence[] {
  return entries.filter(
    (entry) =>
      entry.kind === "allowlist" &&
      (agentId === undefined ||
        (entry.agentId !== undefined &&
          (normalizeAgentId(entry.agentId) === normalizeAgentId(agentId) ||
            entry.agentId === "*"))),
  );
}

function execApprovalFinding(
  entry: PolicyExecApprovalEvidence | undefined,
  params: Parameters<typeof policyEvidenceFinding>[1],
): HealthFinding {
  return policyEvidenceFinding({ source: entry?.source ?? EXEC_APPROVALS_POLICY_URI }, params, {
    path: EXEC_APPROVALS_POLICY_DOCUMENT_NAME,
  });
}
