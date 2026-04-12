// Mandatory-sandbox helper (RI-026 + RI-030)
// Centralizes the "does this skill need to run in a sandbox?" decision so
// the skill loader and runtime both ask the same question.
//
// Two inputs are supported:
//   - category (RI-026 initial shape): broad classification of the skill
//   - certTier (RI-030 refinement):    ClawHub certification tier — more
//                                      precise, preferred when present
//
// When certTier is provided it wins. When only category is provided the
// helper falls back to the pre-RI-030 behavior. This keeps old callers
// working while letting new callers use the finer-grained signal.

export type SkillCategory = "premium" | "proprietary" | "community";
export type SkillCertTier = "certified" | "verified" | "unverified";

export interface MandatorySandboxDecision {
  required: boolean;
  reason: string;
  /** Suggested default network policy mode for the sandbox. `none` for
   *  strictest isolation, `open` for default bridge. Callers may override
   *  with an explicit per-agent network policy from network-policy.ts. */
  defaultNetworkMode: "none" | "open";
}

/**
 * Category-only decision (RI-026). Used when the caller only knows the
 * skill's broad category. `community` always sandboxes; `premium` and
 * `proprietary` are first-party and may opt out via workspace mode.
 */
export function requiresMandatorySandbox(
  category: SkillCategory | string,
): MandatorySandboxDecision {
  if (category === "community") {
    return {
      required: true,
      reason: "community skills must run in a sandbox (RI-026)",
      defaultNetworkMode: "open",
    };
  }
  if (category === "premium" || category === "proprietary") {
    return {
      required: false,
      reason: `${category} (first-party) skills may run un-sandboxed if the workspace sandbox mode allows it`,
      defaultNetworkMode: "open",
    };
  }
  // Unknown category — fail closed.
  return {
    required: true,
    reason: `unknown skill category "${category}" — fail-closed to sandbox`,
    defaultNetworkMode: "none",
  };
}

/**
 * Cert-tier decision (RI-030). Preferred when the caller knows the
 * skill's ClawHub certification tier. Rules:
 *   certified  — not required (workspace mode decides), defaults to open
 *   verified   — required, defaults to open (automated scans green)
 *   unverified — required, defaults to none (strict isolation)
 */
export function requiresMandatorySandboxForTier(
  certTier: SkillCertTier | string,
): MandatorySandboxDecision {
  if (certTier === "certified") {
    return {
      required: false,
      reason: "certified skills may run un-sandboxed if the workspace sandbox mode allows it",
      defaultNetworkMode: "open",
    };
  }
  if (certTier === "verified") {
    return {
      required: true,
      reason: "verified skills must run in a mandatory sandbox with default bridge network",
      defaultNetworkMode: "open",
    };
  }
  if (certTier === "unverified") {
    return {
      required: true,
      reason: "unverified skills must run in a strict sandbox with no outbound network by default",
      defaultNetworkMode: "none",
    };
  }
  // Unknown tier — fail closed to the strictest mode.
  return {
    required: true,
    reason: `unknown cert tier "${certTier}" — fail-closed to strict sandbox`,
    defaultNetworkMode: "none",
  };
}
