import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty as normalizePolicyChannelId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyAgentWorkspaceEvidence, PolicyToolPostureEvidence } from "../policy-state.js";
import { getPolicyPath } from "../policy-value.js";
import {
  POLICY_RULE_METADATA,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./metadata.js";
import { policyShapeFinding } from "./shape-helpers.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";
import { ocPathSegment } from "./utils.js";

export function scopedWorkspaceAgentMatches(
  entry: PolicyAgentWorkspaceEvidence,
  policyAgentId: string,
  entries: readonly PolicyAgentWorkspaceEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return entry.scope === "defaults" && !hasScopedAgentEvidence(entries, entry.kind, policyAgentId);
}

export function scopedToolAgentMatches(
  entry: PolicyToolPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicyToolPostureEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return entry.scope === "global" && !hasScopedAgentEvidence(entries, entry.kind, policyAgentId);
}

function hasScopedAgentEvidence(
  entries: readonly (PolicyAgentWorkspaceEvidence | PolicyToolPostureEvidence)[],
  kind: PolicyAgentWorkspaceEvidence["kind"] | PolicyToolPostureEvidence["kind"],
  policyAgentId: string,
): boolean {
  return entries.some(
    (candidate) =>
      candidate.scope === "agent" &&
      candidate.kind === kind &&
      scopedAgentIdMatches(candidate.agentId, policyAgentId),
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
      agentScopedPolicyOverlays(policy).some(([, overlay]) => hasRules(overlay)))
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

function agentScopedPolicyOverlays(
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
  const targets: AgentScopedPolicyTarget[] = [];
  for (const [scopeName, overlay] of agentScopedPolicyOverlays(policy)) {
    if (!Array.isArray(overlay.agentIds)) {
      continue;
    }
    for (const rawAgentId of overlay.agentIds) {
      if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
        continue;
      }
      targets.push({ scopeName, agentId: normalizeAgentId(rawAgentId), overlay });
    }
  }
  return targets;
}

export function channelScopedPolicyTargets(policy: unknown): readonly ChannelScopedPolicyTarget[] {
  const targets: ChannelScopedPolicyTarget[] = [];
  for (const [scopeName, overlay] of agentScopedPolicyOverlays(policy)) {
    if (!Array.isArray(overlay.channelIds)) {
      continue;
    }
    for (const rawChannelId of overlay.channelIds) {
      if (typeof rawChannelId !== "string" || rawChannelId.trim() === "") {
        continue;
      }
      targets.push({ scopeName, channelId: normalizePolicyChannelId(rawChannelId), overlay });
    }
  }
  return targets;
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
      normalize: normalizeAgentId,
    }) ??
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "channelIds",
      selectorLabel: "channel",
      normalize: normalizePolicyChannelId,
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
    readonly normalize: (value: string) => string;
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
    const selectorValues = overlay[params.selector];
    if (!Array.isArray(selectorValues)) {
      continue;
    }
    const fields = scopedPolicyFields(scopeName, overlay, params.selector);
    for (const rawSelectorValue of selectorValues) {
      if (typeof rawSelectorValue !== "string" || rawSelectorValue.trim() === "") {
        continue;
      }
      const selectorValue = params.normalize(rawSelectorValue);
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
        if (previous !== undefined) {
          if (isPolicyValueAtLeastAsStrict(field.metadata, field.value, previous.field.value)) {
            seen.set(key, {
              propertyPath: `scopes.${scopeName}.${field.propertyPath}`,
              field,
            });
            continue;
          }
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
