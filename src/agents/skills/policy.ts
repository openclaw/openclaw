import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

function normalizeSkillNames(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(new Set(normalizeStringEntries(input))).toSorted();
}

function normalizeAgentOverride(input: unknown): {
  enabled: string[];
  disabled: string[];
} {
  if (!input || typeof input !== "object") {
    return { enabled: [], disabled: [] };
  }
  const value = input as { enabled?: unknown; disabled?: unknown };
  return {
    enabled: normalizeSkillNames(value.enabled),
    disabled: normalizeSkillNames(value.disabled),
  };
}

function resolveAgentOverride(
  config: OpenClawConfig | undefined,
  normalizedAgentId: string,
): {
  enabled: string[];
  disabled: string[];
} {
  const overrides = config?.skills?.policy?.agentOverrides;
  if (!overrides || typeof overrides !== "object") {
    return { enabled: [], disabled: [] };
  }
  for (const [rawAgentId, override] of Object.entries(overrides)) {
    if (normalizeAgentId(rawAgentId) === normalizedAgentId) {
      return normalizeAgentOverride(override);
    }
  }
  return { enabled: [], disabled: [] };
}

function buildEffectiveSkills(params: {
  globalEnabled: string[];
  enabled: string[];
  disabled: string[];
}): string[] {
  const disabled = new Set(params.disabled);
  const effective = new Set<string>();
  for (const name of params.globalEnabled) {
    if (!disabled.has(name)) {
      effective.add(name);
    }
  }
  for (const name of params.enabled) {
    effective.add(name);
  }
  return [...effective].toSorted();
}

function normalizePolicyComparisonList(input?: string[]): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(new Set(normalizeStringEntries(input))).toSorted();
}

export type EffectiveSkillPolicy = NonNullable<SkillSnapshot["policy"]> & {
  effectiveSet: ReadonlySet<string>;
};

export function resolveEffectiveSkillPolicy(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
): EffectiveSkillPolicy | undefined {
  const policy = config?.skills?.policy;
  if (!policy || typeof policy !== "object") {
    return undefined;
  }

  const resolvedAgentId = normalizeAgentId(agentId);
  const globalEnabled = normalizeSkillNames(policy.globalEnabled);
  const override = resolveAgentOverride(config, resolvedAgentId);
  const effective = buildEffectiveSkills({
    globalEnabled,
    enabled: override.enabled,
    disabled: override.disabled,
  });

  return {
    agentId: resolvedAgentId,
    globalEnabled,
    agentEnabled: override.enabled,
    agentDisabled: override.disabled,
    effective,
    effectiveSet: new Set(effective),
  };
}

export function matchesSkillPolicySnapshot(
  cached: SkillSnapshot["policy"] | undefined,
  next: SkillSnapshot["policy"] | undefined,
): boolean {
  if (!cached || !next) {
    return cached === next;
  }
  if (cached.agentId !== next.agentId) {
    return false;
  }
  const keys: Array<"globalEnabled" | "agentEnabled" | "agentDisabled" | "effective"> = [
    "globalEnabled",
    "agentEnabled",
    "agentDisabled",
    "effective",
  ];
  return keys.every((key) => {
    const left = normalizePolicyComparisonList(cached[key]);
    const right = normalizePolicyComparisonList(next[key]);
    if (left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => value === right[index]);
  });
}

export function isSkillAllowedByPolicy(
  entry: SkillEntry,
  policy: EffectiveSkillPolicy | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  const skillKey = resolveSkillKey(entry.skill, entry);
  if (policy.effectiveSet.has(skillKey)) {
    return true;
  }
  return policy.effectiveSet.has(entry.skill.name);
}
