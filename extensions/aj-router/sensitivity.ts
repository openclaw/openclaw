/**
 * Sensitivity gate.
 *
 * Given the configured sensitivity label and a candidate `provider/model`
 * reference, either:
 *   - approve the candidate as-is, or
 *   - return a forced alias (e.g. privileged → privileged alias → local model), or
 *   - reject the candidate because its provider is not in the allowed list.
 *
 * Keeps the policy logic in one file so it is easy to audit against the
 * sensitivity policy doc.
 */

import type { RouterConfig, SensitivityRule } from "./config.js";

const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "llamafile"]);

export type SensitivityDecision =
  | { kind: "allow" }
  | { kind: "force-alias"; alias: string; reason: string }
  | { kind: "reject"; reason: string };

function providerIdFromRef(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(0, slash);
}

function isLocalProvider(ref: string): boolean {
  return LOCAL_PROVIDERS.has(providerIdFromRef(ref));
}

function isAllowedProvider(ref: string, rule: SensitivityRule | undefined): boolean {
  if (!rule?.allowedProviders) {
    return true;
  }
  if (rule.allowedProviders === "*") {
    return true;
  }
  return rule.allowedProviders.includes(providerIdFromRef(ref));
}

export type EvaluateParams = {
  config: RouterConfig;
  /** Sensitivity label on the request; empty/undefined uses `defaultSensitivity`. */
  sensitivity: string | undefined;
  /** Candidate model reference the router picked before sensitivity review. */
  candidateModelRef: string;
};

/**
 * Evaluate the sensitivity rule for a candidate model reference.
 *
 * Decision order:
 *   1. `forceAlias` — privileged data always routes through the forced alias.
 *      If that alias would resolve to an external provider AND `blockExternal`
 *      is set, return `reject` so the hook can bail out hard.
 *   2. `allowedProviders` — if the candidate provider is not in the list,
 *      reject.
 *   3. Otherwise, allow.
 */
export function evaluate(params: EvaluateParams): SensitivityDecision {
  const { config, candidateModelRef } = params;
  const label = params.sensitivity ?? config.defaultSensitivity;
  const rule = config.sensitivity[label];

  if (rule?.forceAlias) {
    const forcedRef = config.aliases[rule.forceAlias];
    if (!forcedRef) {
      return {
        kind: "reject",
        reason: `sensitivity '${label}' forces alias '${rule.forceAlias}' but it is not defined`,
      };
    }
    if (rule.blockExternal && !isLocalProvider(forcedRef)) {
      return {
        kind: "reject",
        reason: `sensitivity '${label}' blocks external providers; forced alias '${rule.forceAlias}' → '${forcedRef}' is not local`,
      };
    }
    return {
      kind: "force-alias",
      alias: rule.forceAlias,
      reason: `sensitivity '${label}' forces alias '${rule.forceAlias}'`,
    };
  }

  if (!isAllowedProvider(candidateModelRef, rule)) {
    return {
      kind: "reject",
      reason: `sensitivity '${label}' does not allow provider '${providerIdFromRef(candidateModelRef)}'`,
    };
  }

  return { kind: "allow" };
}
