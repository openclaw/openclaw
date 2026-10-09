import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { EXEC_APPROVALS_POLICY_URI, execApprovalsPolicyUri } from "../exec-approvals-uri.js";
import type { PolicyExecApprovalEvidence } from "../policy-state.js";
import { getPolicyPath } from "../policy-value.js";
import { policyShapeFinding, unsupportedPolicyKey } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function execApprovalAllowlistExpectedShapeFinding(
  value: unknown,
  params: {
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an array.`,
      `Fix ${params.policyPath} so ${params.property} is an array of exec approval allowlist entries.`,
    );
  }
  const invalidIndex = value.findIndex(
    (entry) => execApprovalAllowlistRequirement(entry) === undefined,
  );
  if (invalidIndex < 0) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.target}/#${invalidIndex}`,
    `${params.policyPath} ${params.property}[${invalidIndex}] must be a non-empty string or an object with pattern and optional argPattern strings.`,
    `Use entries such as "deploy" or { "pattern": "deploy", "argPattern": "^--prod$" }.`,
  );
}

type ExecApprovalAllowlistRequirement = {
  readonly key: string;
  readonly pattern: string;
  readonly argPattern?: string;
};

export function readExecApprovalAllowlistRequirements(
  policy: unknown,
  path: readonly string[],
): readonly ExecApprovalAllowlistRequirement[] | undefined {
  const current = getPolicyPath(policy, path);
  if (!Array.isArray(current)) {
    return undefined;
  }
  const entries = current.map(execApprovalAllowlistRequirement);
  return entries.every((entry): entry is ExecApprovalAllowlistRequirement => entry !== undefined)
    ? entries
    : undefined;
}

function execApprovalAllowlistRequirement(
  value: unknown,
): ExecApprovalAllowlistRequirement | undefined {
  if (typeof value === "string") {
    const pattern = value.trim();
    return pattern === "" ? undefined : execApprovalAllowlistRequirementFromParts(pattern);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (unsupportedPolicyKey(value, ["argPattern", "pattern"]) !== undefined) {
    return undefined;
  }
  const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
  if (pattern === "") {
    return undefined;
  }
  const argPattern = typeof value.argPattern === "string" ? value.argPattern.trim() : undefined;
  if (value.argPattern !== undefined && argPattern === undefined) {
    return undefined;
  }
  return execApprovalAllowlistRequirementFromParts(
    pattern,
    argPattern === "" ? undefined : argPattern,
  );
}

function execApprovalAllowlistRequirementFromParts(
  pattern: string,
  argPattern?: string,
): ExecApprovalAllowlistRequirement {
  return {
    key: execApprovalAllowlistRequirementKey(pattern, argPattern),
    pattern,
    ...(argPattern === undefined ? {} : { argPattern }),
  };
}

export function execApprovalAllowlistRequirementKey(
  pattern: string,
  argPattern: string | undefined,
): string {
  return `${pattern}\0${argPattern ?? ""}`;
}

export function execApprovalAllowlistMissingTarget(agentId: string | undefined): string {
  return agentId === undefined
    ? EXEC_APPROVALS_POLICY_URI
    : execApprovalsPolicyUri(`agents/${ocPathSegment(agentId)}/allowlist`);
}

export function formatExecApprovalAllowlistEntry(
  entry: Pick<PolicyExecApprovalEvidence, "pattern" | "argPattern"> | undefined,
): string {
  const pattern = entry?.pattern ?? "";
  return entry?.argPattern === undefined ? pattern : `${pattern} argPattern=${entry.argPattern}`;
}

export function execApprovalAgentEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  defaults: PolicyExecApprovalEvidence | undefined,
  field: "security" | "autoAllowSkills",
  agentId?: string,
): readonly PolicyExecApprovalEvidence[] {
  const agents = entries.filter((entry) => entry.kind === "agent");
  const wildcard = agents.find((entry) => entry.agentId === "*");
  const hasValue = (entry: PolicyExecApprovalEvidence) =>
    entry[field] !== undefined || (field === "security" && entry.securityConfigured === true);
  if (agentId === undefined) {
    const explicit = agents.filter(
      (entry) => hasValue(entry) || (field === "security" && entry.agentId === "*"),
    );
    const usesDefaults =
      field === "security" ? wildcard === undefined : wildcard?.autoAllowSkills === undefined;
    return usesDefaults
      ? [...explicit, defaults ?? syntheticExecApprovalAgentEntry("*")]
      : explicit;
  }
  const exact = agents.find(
    (entry) =>
      entry.agentId !== undefined && normalizeAgentId(entry.agentId) === normalizeAgentId(agentId),
  );
  if (exact !== undefined && hasValue(exact)) {
    return [exact];
  }
  if (wildcard?.[field] !== undefined) {
    return [wildcard];
  }
  const inherited = field === "security" ? (exact ?? wildcard) : undefined;
  return [inherited ?? defaults ?? syntheticExecApprovalAgentEntry(agentId)];
}

function syntheticExecApprovalAgentEntry(agentId: string): PolicyExecApprovalEvidence {
  return {
    id: `agent:${agentId}:runtime-defaults`,
    kind: "agent",
    source: EXEC_APPROVALS_POLICY_URI,
    agentId,
  };
}
