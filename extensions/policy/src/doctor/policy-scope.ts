import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty as normalizePolicyChannelId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  PolicyAgentWorkspaceEvidence,
  PolicyDataHandlingEvidence,
  PolicyToolPostureEvidence,
} from "../policy-state.js";
import { getPolicyPath } from "../policy-value.js";
import {
  POLICY_RULE_METADATA,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./metadata.js";
import { policyShapeFinding } from "./shape-helpers.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";
import { ocPathSegment } from "./utils.js";

type ScopedAgentEvidence =
  | PolicyAgentWorkspaceEvidence
  | PolicyToolPostureEvidence
  | PolicyDataHandlingEvidence;

export function scopedAgentEvidenceMatches(
  entry: ScopedAgentEvidence,
  policyAgentId: string,
  entries: readonly ScopedAgentEvidence[],
  inheritedEntry: boolean,
): boolean {
  return (
    scopedAgentIdMatches(entry.agentId, policyAgentId) ||
    (inheritedEntry &&
      !entries.some(
        (candidate) =>
          candidate.scope === "agent" &&
          candidate.kind === entry.kind &&
          scopedAgentIdMatches(candidate.agentId, policyAgentId),
      ))
  );
}

export function scopedAgentIdMatches(
  evidenceAgentId: string | undefined,
  policyAgentId: string,
): boolean {
  return (
    evidenceAgentId !== undefined &&
    normalizeAgentId(evidenceAgentId) === normalizeAgentId(policyAgentId)
  );
}

export function policyHasRules(
  policy: unknown,
  section:
    | "agents"
    | "auth"
    | "dataHandling"
    | "execApprovals"
    | "gateway"
    | "ingress"
    | "sandbox"
    | "secrets"
    | "tools",
): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  const hasRules = (document: Record<string, unknown>) => {
    // Even an empty approvals section requests artifact evidence.
    if (section === "execApprovals") {
      const value = document.execApprovals;
      return (
        isRecord(value) &&
        (value.requireFile !== undefined || isRecord(value.defaults) || isRecord(value.agents))
      );
    }
    return POLICY_RULE_METADATA.some(
      (rule) =>
        rule.policyPath[0] === section &&
        (section !== "tools" || rule.policyPath[1] !== "requireMetadata") &&
        getPolicyPath(document, rule.policyPath) !== undefined,
    );
  };
  return (
    hasRules(policy) ||
    (section !== "auth" &&
      section !== "gateway" &&
      section !== "secrets" &&
      scopedPolicyOverlays(policy).some(([, overlay]) => hasRules(overlay)))
  );
}

type AgentScopedPolicyTarget = {
  readonly scopeName: string;
  readonly agentId: string;
  readonly overlay: Record<string, unknown>;
};

type ChannelScopedPolicyTarget = {
  readonly scopeName: string;
  readonly channelId: string;
  readonly overlay: Record<string, unknown>;
};

export function scopedPolicyOverlays(
  policy: unknown,
): readonly (readonly [string, Record<string, unknown>])[] {
  if (!isRecord(policy) || !isRecord(policy.scopes)) {
    return [];
  }
  return Object.entries(policy.scopes).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

export function agentScopedPolicyTargets(policy: unknown): readonly AgentScopedPolicyTarget[] {
  return scopedPolicyOverlays(policy).flatMap(([scopeName, overlay]) =>
    normalizePolicySelectorValues(overlay.agentIds, "agentIds").map((agentId) => ({
      scopeName,
      agentId,
      overlay,
    })),
  );
}

export function channelScopedPolicyTargets(policy: unknown): readonly ChannelScopedPolicyTarget[] {
  return scopedPolicyOverlays(policy).flatMap(([scopeName, overlay]) =>
    normalizePolicySelectorValues(overlay.channelIds, "channelIds").map((channelId) => ({
      scopeName,
      channelId,
      overlay,
    })),
  );
}

export function normalizePolicySelectorValues(
  value: unknown,
  selector: PolicyScopeSelectorKind,
): readonly string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map(selector === "agentIds" ? normalizeAgentId : normalizePolicyChannelId)
    : [];
}

type ScopedPolicyField = {
  readonly propertyPath: string;
  readonly targetPath: string;
  readonly metadata: PolicyRuleMetadata;
  readonly value: unknown;
};

export function duplicateScopedPolicyFieldFinding(
  scopes: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  return (
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "agentIds",
      selectorLabel: "agent",
    }) ??
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "channelIds",
      selectorLabel: "channel",
    })
  );
}

function duplicateScopedFieldFinding(
  scopes: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
    readonly selector: PolicyScopeSelectorKind;
    readonly selectorLabel: string;
  },
): HealthFinding | undefined {
  const seen = new Map<
    string,
    {
      readonly propertyPath: string;
      readonly field: ScopedPolicyField;
    }
  >();
  for (const [scopeName, overlay] of Object.entries(scopes)) {
    if (!isRecord(overlay)) {
      continue;
    }
    const fields = scopedPolicyFields(scopeName, overlay, params.selector);
    for (const selectorValue of normalizePolicySelectorValues(
      overlay[params.selector],
      params.selector,
    )) {
      for (const field of fields) {
        const topLevelValue = getPolicyPath(params.policy, field.metadata.policyPath);
        if (
          topLevelValue !== undefined &&
          !isPolicyValueAtLeastAsStrict(field.metadata, field.value, topLevelValue)
        ) {
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${field.targetPath}`,
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is weaker than the top-level ${field.propertyPath} policy.`,
            `Use an equally or more restrictive scoped value, or remove the scoped override.`,
          );
        }
        const key = `${selectorValue}\0${field.propertyPath}`;
        const previous = seen.get(key);
        if (
          previous !== undefined &&
          !isPolicyValueAtLeastAsStrict(field.metadata, field.value, previous.field.value)
        ) {
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${field.targetPath}`,
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is not an equally or more restrictive override of ${previous.propertyPath} for ${params.selectorLabel} '${selectorValue}'.`,
            `Use one effective scoped value per ${params.selectorLabel}, or make later scoped values stricter according to policy metadata.`,
          );
        }
        seen.set(key, {
          propertyPath: `scopes.${scopeName}.${field.propertyPath}`,
          field,
        });
      }
    }
  }
  return undefined;
}

function scopedPolicyFields(
  scopeName: string,
  overlay: Record<string, unknown>,
  selector: PolicyScopeSelectorKind,
): readonly ScopedPolicyField[] {
  const prefix = `scopes/${ocPathSegment(scopeName)}`;
  return POLICY_RULE_METADATA.filter((rule) => rule.scopeSelectors?.includes(selector) === true)
    .map((rule) => ({ rule, value: getPolicyPath(overlay, rule.policyPath) }))
    .filter((entry) => entry.value !== undefined)
    .map(({ rule, value }) => ({
      propertyPath: rule.policyPath.join("."),
      targetPath: `${prefix}/${rule.policyPath.map(ocPathSegment).join("/")}`,
      metadata: rule,
      value,
    }));
}
