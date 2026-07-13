import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  PolicyAgentWorkspaceEvidence,
  PolicyEvidence,
  PolicyIngressEvidence,
} from "../policy-state.js";
import { agentsPolicyShapeFinding, ingressPolicyShapeFinding } from "./access-shapes.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./metadata.js";
import { SUPPORTED_AUTH_PROFILE_METADATA } from "./policy-constants.js";
import { isChannelDenyRule, normalizePolicyChannelId } from "./policy-runtime.js";
import {
  agentScopedPolicyTargets,
  channelScopedPolicyTargets,
  scopedWorkspaceAgentMatches,
} from "./policy-scope.js";
import { hasValidScopedPolicy } from "./policy-shape.js";
import { unsupportedPolicyKey } from "./shape-helpers.js";
import { ocPathSegment, readPolicyBoolean, readString, readStringList } from "./utils.js";

export function authProfileMetadataRequirementFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.auth) ||
    !isRecord(policy.auth.profiles) ||
    policy.auth.profiles.requireMetadata === undefined
  ) {
    return [];
  }
  if (!Array.isArray(policy.auth.profiles.requireMetadata)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} auth.profiles.requireMetadata must be an array of metadata keys.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/auth/profiles/requireMetadata`,
        fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`,
      },
    ];
  }
  const invalidIndex = policy.auth.profiles.requireMetadata.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_AUTH_PROFILE_METADATA.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} auth.profiles.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/auth/profiles/requireMetadata/#${invalidIndex}`,
      fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`,
    },
  ];
}

export function invalidChannelDenyRuleFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.channels) || policy.channels.denyRules === undefined) {
    return [];
  }
  if (!Array.isArray(policy.channels.denyRules)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} channels.denyRules must be an array.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/channels/denyRules`,
        fixHint: `Fix ${policyPath} so channel deny rules are an array.`,
      },
    ];
  }
  for (const [index, rule] of policy.channels.denyRules.entries()) {
    if (!isRecord(rule)) {
      continue;
    }
    const unsupportedRuleKey = unsupportedPolicyKey(rule, ["id", "reason", "when"]);
    if (unsupportedRuleKey !== undefined) {
      return [
        {
          checkId: CHECK_IDS.policyInvalidFile,
          severity: "error",
          message: `${policyPath} channels.denyRules[${index}].${unsupportedRuleKey} is not supported in channel deny rules.`,
          source: "policy",
          path: policyPath,
          target: `oc://${policyDocName}/channels/denyRules/#${index}/${ocPathSegment(unsupportedRuleKey)}`,
          fixHint: `Remove channels.denyRules[${index}].${unsupportedRuleKey} or use id, when.provider, and reason.`,
        },
      ];
    }
    if (isRecord(rule.when)) {
      const unsupportedWhenKey = unsupportedPolicyKey(rule.when, ["provider"]);
      if (unsupportedWhenKey !== undefined) {
        return [
          {
            checkId: CHECK_IDS.policyInvalidFile,
            severity: "error",
            message: `${policyPath} channels.denyRules[${index}].when.${unsupportedWhenKey} is not supported in channel deny rules.`,
            source: "policy",
            path: policyPath,
            target: `oc://${policyDocName}/channels/denyRules/#${index}/when/${ocPathSegment(unsupportedWhenKey)}`,
            fixHint: `Remove channels.denyRules[${index}].when.${unsupportedWhenKey} or use when.provider.`,
          },
        ];
      }
    }
  }
  const invalid = policy.channels.denyRules.findIndex((rule) => !isChannelDenyRule(rule));
  if (invalid < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} channels.denyRules[${invalid}] must define when.provider as a string.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/channels/denyRules/#${invalid}`,
      fixHint: `Fix ${policyPath} so each channel deny rule has a provider match.`,
    },
  ];
}

export function ingressFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const ingressPolicy = policy.ingress;
  if (
    ingressPolicyShapeFinding(ingressPolicy, { policyDocName, policyPath }) === undefined &&
    isRecord(ingressPolicy)
  ) {
    findings.push(
      ...ingressFindingsForRule(ingressPolicy, policyDocName, "ingress", evidence, () => true),
    );
  }
  if (hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    for (const target of channelScopedPolicyTargets(policy)) {
      if (
        ingressPolicyShapeFinding(target.overlay.ingress, {
          policyDocName,
          policyPath,
          targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          propertyPrefix: `scopes.${target.scopeName}.ingress`,
          allowSession: false,
        }) !== undefined ||
        !isRecord(target.overlay.ingress)
      ) {
        continue;
      }
      findings.push(
        ...ingressFindingsForRule(
          target.overlay.ingress,
          policyDocName,
          `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          evidence,
          (entry) => scopedIngressChannelMatches(entry, target.channelId),
        ),
      );
    }
  }
  return findings;
}

function ingressFindingsForRule(
  ingressPolicy: Record<string, unknown> | undefined,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (!isRecord(ingressPolicy)) {
    return [];
  }
  return [
    ...ingressDmScopeFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressDmPolicyFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressOpenGroupFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressRequireMentionFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function ingressDmScopeFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const required = readString(ingressPolicy, ["session", "requireDmScope"]);
  if (required === undefined) {
    return [];
  }
  return ingressEntries(evidence, "sessionDmScope")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== required)
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressDmScopeUnapproved,
        message: `session.dmScope '${entry.value ?? ""}' does not match policy.`,
        requirement: `oc://${policyDocName}/${requirementBase}/session/requireDmScope`,
        fixHint:
          "Set session.dmScope to the required isolation scope or update policy after review.",
      }),
    );
}

function ingressDmPolicyFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(ingressPolicy, ["channels", "allowDmPolicies"]));
  if (allowed.size === 0) {
    return [];
  }
  return ingressEntries(evidence, "channelDmPolicy")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressDmPolicyUnapproved,
        message: `${ingressLabel(entry)} uses unapproved DM policy '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/allowDmPolicies`,
        fixHint: "Set the channel DM policy to an allowed value or update policy after review.",
      }),
    );
}

function ingressOpenGroupFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(ingressPolicy, ["channels", "denyOpenGroups"]) !== true) {
    return [];
  }
  return ingressEntries(evidence, "channelGroupPolicy")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== "allowlist" && entry.value !== "disabled")
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressOpenGroupsDenied,
        message: `${ingressLabel(entry)} allows open group ingress.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/denyOpenGroups`,
        fixHint: "Set groupPolicy to allowlist or disabled, or update policy after review.",
      }),
    );
}

function ingressRequireMentionFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(ingressPolicy, ["channels", "requireMentionInGroups"]) !== true) {
    return [];
  }
  const groupPolicies = ingressEntries(evidence, "channelGroupPolicy").filter(evidenceFilter);
  return ingressEntries(evidence, "channelRequireMention")
    .filter(evidenceFilter)
    .filter((entry) => !isGroupIngressDisabled(entry, groupPolicies))
    .filter((entry) => entry.value !== true)
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressGroupMentionRequired,
        message: `${ingressLabel(entry)} does not require group mentions.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/requireMentionInGroups`,
        fixHint:
          "Set requireMention=true for the channel/group entry or update policy after review.",
      }),
    );
}

function isGroupIngressDisabled(
  entry: PolicyIngressEvidence,
  groupPolicies: readonly PolicyIngressEvidence[],
): boolean {
  const entryParent = ocPathParent(entry.source);
  const channelDefaultsParent = "oc://openclaw.config/channels/defaults";
  const matches = groupPolicies
    .filter((candidate) => {
      const candidateParent = ocPathParent(candidate.source);
      return (
        candidate.channel === entry.channel &&
        (candidate.accountId ?? "") === (entry.accountId ?? "") &&
        (candidateParent === channelDefaultsParent ||
          entryParent === candidateParent ||
          entryParent.startsWith(`${candidateParent}/`))
      );
    })
    .toSorted(
      (left, right) => ocPathParent(right.source).length - ocPathParent(left.source).length,
    );
  return matches[0]?.value === "disabled";
}

function ocPathParent(source: string): string {
  return source.slice(0, Math.max(0, source.lastIndexOf("/")));
}

function ingressEntries(
  evidence: PolicyEvidence,
  kind: PolicyIngressEvidence["kind"],
): readonly PolicyIngressEvidence[] {
  return (evidence.ingress ?? []).filter((entry) => entry.kind === kind);
}

function scopedIngressChannelMatches(
  entry: PolicyIngressEvidence,
  policyChannelId: string,
): boolean {
  return normalizePolicyChannelId(entry.channel ?? "") === policyChannelId;
}

function ingressFinding(
  entry: PolicyIngressEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function ingressLabel(entry: PolicyIngressEvidence): string {
  const account = entry.accountId === undefined ? "" : ` account '${entry.accountId}'`;
  const group = entry.groupId === undefined ? "" : ` group '${entry.groupId}'`;
  return `channel '${entry.channel ?? "unknown"}'${account}${group}`;
}

export function agentWorkspaceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (
    agentsPolicyShapeFinding(isRecord(policy) ? policy.agents : undefined, {
      policyDocName,
      policyPath,
    }) !== undefined
  ) {
    return [];
  }
  return [
    ...agentWorkspaceAccessFindings(
      policy,
      ["agents", "workspace", "allowedAccess"],
      policyDocName,
      "agents/workspace/allowedAccess",
      evidence,
      () => true,
    ),
    ...agentWorkspaceToolDenyFindings(
      policy,
      ["agents", "workspace", "denyTools"],
      policyDocName,
      "agents/workspace/denyTools",
      evidence,
      () => true,
    ),
    ...agentScopedWorkspaceFindings(policy, policyPath, policyDocName, evidence),
  ];
}

function agentWorkspaceAccessFindings(
  policy: unknown,
  policyPath: readonly string[],
  policyDocName: string,
  requirementPath: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyAgentWorkspaceEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(policy, policyPath));
  if (allowed.size === 0) {
    return [];
  }
  return (evidence.agentWorkspace ?? [])
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        entry.kind === "workspaceAccess" &&
        entry.value !== undefined &&
        (entry.sandboxEnabled !== true || !allowed.has(entry.value)),
    )
    .map((entry): HealthFinding => {
      const label = entry.agentId === undefined ? "agents.defaults" : `agent '${entry.agentId}'`;
      const sandboxDisabled = entry.sandboxEnabled !== true;
      const observed = sandboxDisabled
        ? `sandbox mode '${entry.sandboxMode ?? "off"}'`
        : `sandbox workspaceAccess '${entry.value ?? ""}'`;
      const ocPath = sandboxDisabled ? (entry.sandboxModeSource ?? entry.source) : entry.source;
      return {
        checkId: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
        severity: "error",
        message: `${label} ${observed} is not allowed by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath,
        target: ocPath,
        requirement: `oc://${policyDocName}/${requirementPath}`,
        fixHint: "Enable sandbox mode with workspaceAccess none/ro or update policy after review.",
      };
    });
}

function agentWorkspaceToolDenyFindings(
  policy: unknown,
  policyPath: readonly string[],
  policyDocName: string,
  requirementPath: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyAgentWorkspaceEvidence) => boolean,
): readonly HealthFinding[] {
  const requiredDeniedTools = new Set(readStringList(policy, policyPath));
  if (requiredDeniedTools.size === 0) {
    return [];
  }
  return (evidence.agentWorkspace ?? [])
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        entry.kind === "toolDeny" &&
        entry.tool !== undefined &&
        requiredDeniedTools.has(entry.tool) &&
        entry.denied !== true,
    )
    .map((entry): HealthFinding => {
      const label = entry.agentId === undefined ? "agents.defaults" : `agent '${entry.agentId}'`;
      return {
        checkId: CHECK_IDS.policyAgentsToolNotDenied,
        severity: "error",
        message: `${label} does not deny required tool '${entry.tool ?? ""}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/${requirementPath}`,
        fixHint:
          "Add the tool to tools.deny or agents.list[].tools.deny, or update policy after review.",
      };
    });
}

function agentScopedWorkspaceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  for (const target of agentScopedPolicyTargets(policy)) {
    const scopedAgents = isRecord(target.overlay.agents) ? target.overlay.agents : {};
    const workspace = isRecord(scopedAgents.workspace) ? scopedAgents.workspace : {};
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/agents/workspace`;
    const evidenceFilter = (entry: PolicyAgentWorkspaceEvidence) =>
      scopedWorkspaceAgentMatches(entry, target.agentId, evidence.agentWorkspace ?? []);
    findings.push(
      ...agentWorkspaceAccessFindings(
        { workspace },
        ["workspace", "allowedAccess"],
        policyDocName,
        `${requirementBase}/allowedAccess`,
        evidence,
        evidenceFilter,
      ),
      ...agentWorkspaceToolDenyFindings(
        { workspace },
        ["workspace", "denyTools"],
        policyDocName,
        `${requirementBase}/denyTools`,
        evidence,
        evidenceFilter,
      ),
    );
  }
  return findings;
}
