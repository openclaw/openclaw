import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { isKnownCoreToolId } from "../tool-catalog.js";
import { buildDeclaredToolAllowlistContext } from "../tool-policy-declared-context.js";
import {
  expandToolGroups,
  normalizeToolPolicyName,
  toolPolicyRestrictsTools,
} from "../tool-policy.js";

// Which tool denies a native harness can enforce itself, so the policy need not restrict it.

export type PluginHarnessToolPolicy = { allow?: string[]; deny?: string[] };

/** Resolve audited identities once for restriction and native-enforcement projection. */
export function resolveHarnessSafeDenies(
  policies: Array<PluginHarnessToolPolicy | undefined>,
  auditedToolNames: readonly string[] | undefined,
  context: Partial<
    Pick<EmbeddedRunAttemptParams, "config" | "workspaceDir" | "preparedModelRuntime">
  >,
): ReadonlySet<string> | undefined {
  if (!auditedToolNames) {
    return undefined;
  }
  const audited = new Set(auditedToolNames.map(normalizeToolPolicyName));
  const safe = new Set([...audited].filter(isKnownCoreToolId));
  const pluginDenies = new Set(
    policies
      .flatMap((policy) => expandToolGroups(policy?.deny))
      .map(normalizeToolPolicyName)
      .filter((name) => audited.has(name) && !safe.has(name)),
  );
  // Manifest ownership is identity, not permission. Avoid metadata work unless
  // an exact denied name was explicitly audited by this harness.
  if (pluginDenies.size > 0) {
    const declared = buildDeclaredToolAllowlistContext({
      config: context.config,
      workspaceDir: context.workspaceDir,
      metadataSnapshot: context.preparedModelRuntime?.metadataSnapshot,
    });
    for (const name of declared?.pluginToolNames ?? []) {
      if (pluginDenies.has(name)) {
        safe.add(name);
      }
    }
  }
  return safe;
}

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
        .filter((name) => safeDenyToolNames.has(name)),
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
    return !safeDenyToolNames.has(normalized);
  });
}

export function policyDeniesAllTools(policy?: { deny?: string[] }): boolean {
  return expandToolGroups(policy?.deny ?? []).some(
    (entry) => normalizeToolPolicyName(entry) === "*",
  );
}
