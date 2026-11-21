import { isKnownCoreToolId } from "../tool-catalog.js";
import {
  expandToolGroups,
  normalizeToolPolicyName,
  toolPolicyRestrictsTools,
} from "../tool-policy.js";

// Which tool denies a native harness can enforce itself, so the policy need not restrict it.

export type PluginHarnessToolPolicy = { allow?: string[]; deny?: string[] };

export function collectHarnessSafeDeniedToolNames(
  policies: Array<PluginHarnessToolPolicy | undefined>,
  safeDenyToolNames: ReadonlySet<string> | undefined,
): string[] {
  if (!safeDenyToolNames) {
    return [];
  }
  return [
    ...new Set(
      policies
        .flatMap((policy) => expandToolGroups(policy?.deny ?? []))
        .map(normalizeToolPolicyName)
        .filter((name) => isKnownCoreToolId(name) && safeDenyToolNames.has(name)),
    ),
  ].toSorted();
}

export function toolPolicyRestrictsHarnessNativeTools(
  policy: PluginHarnessToolPolicy | undefined,
  safeDenyToolNames: ReadonlySet<string> | undefined,
): boolean {
  if (!safeDenyToolNames || !policy || toolPolicyRestrictsTools({ allow: policy.allow })) {
    return toolPolicyRestrictsTools(policy);
  }
  return expandToolGroups(policy.deny ?? []).some((deniedName) => {
    const normalized = normalizeToolPolicyName(deniedName);
    return !isKnownCoreToolId(normalized) || !safeDenyToolNames.has(normalized);
  });
}

export function policyDeniesAllTools(policy?: { deny?: string[] }): boolean {
  return expandToolGroups(policy?.deny ?? []).some(
    (entry) => normalizeToolPolicyName(entry) === "*",
  );
}
