import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyToolEvidence } from "../policy-state-types.js";
import type { PolicyEvidence, PolicyToolPostureEvidence } from "../policy-state.js";
import { expandPolicyToolRequirement, toolListCoversTool } from "../tool-policy-conformance.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { KNOWN_RISK_LEVELS, KNOWN_SENSITIVITY_LEVELS } from "./policy-constants.js";
import { policyEvidenceFinding as toolPostureFinding } from "./policy-evidence-finding.js";
import { agentScopedPolicyTargets, scopedToolAgentMatches } from "./policy-scope.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function toolPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (
    isRecord(policy) &&
    isRecord(policy.tools) &&
    posturePolicyShapeFinding("tools", policy.tools, { policyDocName, policyPath }) === undefined
  ) {
    findings.push(
      ...toolPostureFindingsForRule(policy.tools, policyDocName, "tools", evidence, () => true),
    );
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!isRecord(target.overlay.tools)) {
      continue;
    }
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/tools`;
    if (
      posturePolicyShapeFinding("tools", target.overlay.tools, {
        policyDocName,
        policyPath,
        targetPrefix: requirementBase,
        propertyPrefix: `scopes.${target.scopeName}.tools`,
      }) !== undefined
    ) {
      continue;
    }
    findings.push(
      ...toolPostureFindingsForRule(
        target.overlay.tools,
        policyDocName,
        requirementBase,
        evidence,
        (entry) => scopedToolAgentMatches(entry, target.agentId, evidence.toolPosture ?? []),
      ),
    );
  }
  return findings;
}

function toolPostureFindingsForRule(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const entries = (evidence.toolPosture ?? []).filter(evidenceFilter);
  return [
    ...toolValuePostureFindings(toolsPolicy, policyDocName, requirementBase, entries),
    ...toolAlsoAllowExpectedFindings(toolsPolicy, policyDocName, requirementBase, entries),
    ...toolRequiredDenyFindings(toolsPolicy, policyDocName, requirementBase, entries),
  ];
}

function toolValuePostureFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  entries: readonly PolicyToolPostureEvidence[],
): readonly HealthFinding[] {
  // Keep rule order stable: findings participate in the policy attestation.
  const rules: readonly {
    path: readonly string[];
    kind: PolicyToolPostureEvidence["kind"];
    required?: boolean;
    checkId: (typeof POLICY_CHECK_IDS)[number];
    message: (entry: PolicyToolPostureEvidence) => string;
    fixHint: string;
  }[] = [
    {
      path: ["profiles", "allow"],
      kind: "profile",
      checkId: CHECK_IDS.policyToolsProfileUnapproved,
      message: (entry) =>
        `${toolPostureLabel(entry)} uses unapproved tool profile '${entry.value ?? ""}'.`,
      fixHint: "Use an approved tools.profile value or update policy after review.",
    },
    {
      path: ["fs", "requireWorkspaceOnly"],
      kind: "fsWorkspaceOnly",
      required: true,
      checkId: CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
      message: (entry) =>
        `${toolPostureLabel(entry)} does not require workspace-only filesystem tools.`,
      fixHint: "Set tools.fs.workspaceOnly=true or update policy after review.",
    },
    ...(
      [
        [
          "allowSecurity",
          "execSecurity",
          "exec security",
          CHECK_IDS.policyToolsExecSecurityUnapproved,
        ],
        ["requireAsk", "execAsk", "exec ask", CHECK_IDS.policyToolsExecAskUnapproved],
        ["allowHosts", "execHost", "exec host", CHECK_IDS.policyToolsExecHostUnapproved],
      ] as const
    ).map(([key, kind, label, checkId]) => ({
      path: ["exec", key],
      kind,
      checkId,
      message: (entry: PolicyToolPostureEvidence) =>
        `${toolPostureLabel(entry)} uses unapproved ${label} '${entry.value ?? ""}'.`,
      fixHint: "Adjust the configured tool posture or update policy after review.",
    })),
    {
      path: ["elevated", "allow"],
      kind: "elevatedEnabled",
      required: false,
      checkId: CHECK_IDS.policyToolsElevatedEnabled,
      message: (entry) => `${toolPostureLabel(entry)} permits elevated tool mode.`,
      fixHint: "Set tools.elevated.enabled=false or update policy after review.",
    },
  ];
  return rules.flatMap((rule) => {
    const allowed = new Set(readStringList(toolsPolicy, rule.path));
    if (
      rule.required === undefined
        ? allowed.size === 0
        : readPolicyBoolean(toolsPolicy, rule.path) !== rule.required
    ) {
      return [];
    }
    return entries
      .filter((entry) => entry.kind === rule.kind)
      .filter((entry) =>
        rule.required === undefined
          ? typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase())
          : entry.value !== rule.required,
      )
      .map((entry) =>
        toolPostureFinding(entry, {
          checkId: rule.checkId,
          message: rule.message(entry),
          requirement: `oc://${policyDocName}/${requirementBase}/${rule.path.join("/")}`,
          fixHint: rule.fixHint,
        }),
      );
  });
}

function toolAlsoAllowExpectedFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  entries: readonly PolicyToolPostureEvidence[],
): readonly HealthFinding[] {
  const alsoAllowPolicy = isRecord(toolsPolicy.alsoAllow) ? toolsPolicy.alsoAllow : {};
  if (alsoAllowPolicy.expected === undefined) {
    return [];
  }
  const expected = normalizedStringSet(readStringList(toolsPolicy, ["alsoAllow", "expected"]));
  const findings: HealthFinding[] = [];
  for (const entry of entries.filter((candidate) => candidate.kind === "alsoAllow")) {
    const actual = normalizedStringSet(entry.entries ?? []);
    for (const expectedTool of expected) {
      if (actual.has(expectedTool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsAlsoAllowMissing,
          message: `${toolPostureLabel(entry)} is missing expected tools.alsoAllow entry '${expectedTool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/alsoAllow/expected`,
          fixHint: "Add the expected tools.alsoAllow entry or update policy after review.",
        }),
      );
    }
    for (const actualTool of actual) {
      if (expected.has(actualTool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsAlsoAllowUnexpected,
          message: `${toolPostureLabel(entry)} has unexpected tools.alsoAllow entry '${actualTool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/alsoAllow/expected`,
          fixHint: "Remove the unexpected tools.alsoAllow entry or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function normalizedStringSet(entries: readonly string[]): ReadonlySet<string> {
  return new Set(
    entries
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .toSorted(),
  );
}

function toolRequiredDenyFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  entries: readonly PolicyToolPostureEvidence[],
): readonly HealthFinding[] {
  const required = readStringList(toolsPolicy, ["denyTools"]);
  if (required.length === 0) {
    return [];
  }
  const requiredTools = uniqueStrings(required.flatMap(expandPolicyToolRequirement));
  const findings: HealthFinding[] = [];
  for (const entry of entries.filter((candidate) => candidate.kind === "deny")) {
    for (const tool of requiredTools) {
      if (toolListCoversTool(entry.entries ?? [], tool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsRequiredDenyMissing,
          message: `${toolPostureLabel(entry)} does not deny required tool '${tool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/denyTools`,
          fixHint:
            "Add the tool or group to tools.deny/agents.entries.<id>.tools.deny, or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function toolPostureLabel(entry: PolicyToolPostureEvidence): string {
  return entry.agentId === undefined ? "global tools config" : `agent '${entry.agentId}'`;
}

function toolMetadataFinding(
  tool: PolicyToolEvidence,
  policyDocName: string,
  checkId: (typeof POLICY_CHECK_IDS)[number],
  message: string,
  fixHint: string,
): HealthFinding {
  return {
    checkId,
    severity: "error",
    message,
    source: "policy",
    path: "AGENTS.md",
    line: tool.line,
    ocPath: tool.source,
    target: tool.source,
    requirement: `oc://${policyDocName}/tools/requireMetadata`,
    fixHint,
  };
}

export function toolRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.risk === undefined)
    .map((tool) =>
      toolMetadataFinding(
        tool,
        policyDocName,
        CHECK_IDS.policyMissingToolRisk,
        `AGENTS.md tool '${tool.id}' has no explicit risk classification.`,
        "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias.",
      ),
    );
}

export function toolUnknownRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter(
      (tool) =>
        tool.risk !== undefined &&
        !KNOWN_RISK_LEVELS.includes(tool.risk as (typeof KNOWN_RISK_LEVELS)[number]),
    )
    .map((tool) =>
      toolMetadataFinding(
        tool,
        policyDocName,
        CHECK_IDS.policyUnknownToolRisk,
        `AGENTS.md tool '${tool.id}' declares unknown risk '${tool.risk}'.`,
        `Use one of: ${KNOWN_RISK_LEVELS.join(", ")}.`,
      ),
    );
}

export function toolSensitivityFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? []).flatMap((tool): HealthFinding[] => {
    if (tool.sensitivity === undefined) {
      return [
        toolMetadataFinding(
          tool,
          policyDocName,
          CHECK_IDS.policyMissingToolSensitivity,
          `AGENTS.md tool '${tool.id}' has no declared artifact sensitivity.`,
          `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
        ),
      ];
    }
    if (
      KNOWN_SENSITIVITY_LEVELS.includes(
        tool.sensitivity as (typeof KNOWN_SENSITIVITY_LEVELS)[number],
      )
    ) {
      return [];
    }
    return [
      toolMetadataFinding(
        tool,
        policyDocName,
        CHECK_IDS.policyUnknownToolSensitivity,
        `AGENTS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
        `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
      ),
    ];
  });
}

export function toolOwnerFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.owner === undefined)
    .map((tool) =>
      toolMetadataFinding(
        tool,
        policyDocName,
        CHECK_IDS.policyMissingToolOwner,
        `AGENTS.md tool '${tool.id}' has no declared owner.`,
        "Declare owner:<team-or-person> for this tool.",
      ),
    );
}
