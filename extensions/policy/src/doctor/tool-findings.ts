import type { HealthFinding } from "openclaw/plugin-sdk/health";
import {
  isRecord,
  normalizeStringEntriesLower,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyToolEvidence } from "../policy-state-types.js";
import type { PolicyEvidence, PolicyToolPostureEvidence } from "../policy-state.js";
import { expandPolicyToolRequirement, toolListCoversTool } from "../tool-policy-conformance.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { KNOWN_RISK_LEVELS, KNOWN_SENSITIVITY_LEVELS } from "./policy-constants.js";
import {
  policyEvidenceFinding,
  policyEvidenceRuleFindings,
  type PolicyEvidenceRule,
} from "./policy-evidence-finding.js";
import { scopedAgentEvidenceMatches } from "./policy-scope.js";
import { policySectionTargets } from "./policy-section-targets.js";
import { readPolicyBoolean, readStringList } from "./utils.js";

export function toolPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  const entries = evidence.toolPosture ?? [];
  for (const target of policySectionTargets(policy, policyPath, policyDocName, "tools")) {
    const agentId = target.selectorId;
    const scopedEntries =
      agentId === undefined
        ? entries
        : entries.filter((entry) =>
            scopedAgentEvidenceMatches(entry, agentId, entries, entry.scope === "global"),
          );
    for (const collect of [
      toolValuePostureFindings,
      toolAlsoAllowExpectedFindings,
      toolRequiredDenyFindings,
    ]) {
      findings.push(
        ...collect(target.policy, policyDocName, target.requirementBase, scopedEntries),
      );
    }
  }
  return findings;
}

function toolValuePostureFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  entries: readonly PolicyToolPostureEvidence[],
): readonly HealthFinding[] {
  // Keep rule order stable: findings participate in the policy attestation.
  const rules: readonly (Omit<PolicyEvidenceRule<PolicyToolPostureEvidence>, "violates"> & {
    required?: boolean;
  })[] = [
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
    return policyEvidenceRuleFindings(
      entries,
      [
        {
          ...rule,
          violates: (entry) =>
            rule.required === undefined
              ? typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase())
              : entry.value !== rule.required,
        },
      ],
      policyDocName,
      requirementBase,
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
  const expected = new Set(readStringList(toolsPolicy, ["alsoAllow", "expected"]).toSorted());
  const findings: HealthFinding[] = [];
  for (const entry of entries.filter((candidate) => candidate.kind === "alsoAllow")) {
    const actual = new Set(normalizeStringEntriesLower(entry.entries).toSorted());
    for (const expectedTool of expected) {
      if (actual.has(expectedTool)) {
        continue;
      }
      findings.push(
        policyEvidenceFinding(entry, {
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
        policyEvidenceFinding(entry, {
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
        policyEvidenceFinding(entry, {
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
  return policyEvidenceFinding(
    tool,
    { checkId, message, requirement: `oc://${policyDocName}/tools/requireMetadata`, fixHint },
    { path: "AGENTS.md", line: tool.line },
  );
}

type ToolMetadataIssue = readonly [
  checkId: (typeof POLICY_CHECK_IDS)[number],
  message: string,
  fixHint: string,
];

const TOOL_METADATA_CHECKS: readonly {
  metadata: string;
  issue: (tool: PolicyToolEvidence) => ToolMetadataIssue | undefined;
}[] = [
  {
    metadata: "risk",
    issue: (tool) =>
      tool.risk === undefined
        ? [
            CHECK_IDS.policyMissingToolRisk,
            `AGENTS.md tool '${tool.id}' has no explicit risk classification.`,
            "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias.",
          ]
        : undefined,
  },
  {
    metadata: "risk",
    issue: (tool) =>
      tool.risk !== undefined && !KNOWN_RISK_LEVELS.some((risk) => risk === tool.risk)
        ? [
            CHECK_IDS.policyUnknownToolRisk,
            `AGENTS.md tool '${tool.id}' declares unknown risk '${tool.risk}'.`,
            `Use one of: ${KNOWN_RISK_LEVELS.join(", ")}.`,
          ]
        : undefined,
  },
  {
    metadata: "sensitivity",
    issue: (tool) => {
      if (tool.sensitivity === undefined) {
        return [
          CHECK_IDS.policyMissingToolSensitivity,
          `AGENTS.md tool '${tool.id}' has no declared artifact sensitivity.`,
          `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
        ];
      }
      return KNOWN_SENSITIVITY_LEVELS.some((level) => level === tool.sensitivity)
        ? undefined
        : [
            CHECK_IDS.policyUnknownToolSensitivity,
            `AGENTS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
            `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
          ];
    },
  },
  {
    metadata: "owner",
    issue: (tool) =>
      tool.owner === undefined
        ? [
            CHECK_IDS.policyMissingToolOwner,
            `AGENTS.md tool '${tool.id}' has no declared owner.`,
            "Declare owner:<team-or-person> for this tool.",
          ]
        : undefined,
  },
];

export function toolMetadataFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
  required: ReadonlySet<string>,
): readonly HealthFinding[] {
  return TOOL_METADATA_CHECKS.filter((check) => required.has(check.metadata)).flatMap((check) =>
    (evidence.tools ?? []).flatMap((tool) => {
      const issue = check.issue(tool);
      return issue === undefined ? [] : [toolMetadataFinding(tool, policyDocName, ...issue)];
    }),
  );
}
