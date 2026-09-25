import {
  evaluatePreparedShellAllowlist,
  evaluateShellAllowlistWithAuthorization,
  resolveSafeBins,
} from "../infra/exec-approvals-allowlist.js";
import { resolveExecModePolicy } from "../infra/exec-approvals-core.js";
import type { ExecHost, ExecSecurity } from "../infra/exec-approvals-core.js";
import { maxAsk, minSecurity, requiresExecApproval } from "../infra/exec-approvals-policy.js";
import { resolveSafeBinProfiles, type SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type {
  DelegatedExecRestriction,
  DelegatedParameterUnsupported,
} from "./inherited-tool-parameters.types.js";

export function captureDelegatedExecRestriction(
  defaults: ExecToolDefaults,
  sandboxed = false,
  askFallback: ExecSecurity = "full",
): {
  restriction: DelegatedExecRestriction;
  unsupported: DelegatedParameterUnsupported[];
} {
  const policy = resolveExecModePolicy({
    mode: defaults.mode,
    security: defaults.security ?? "full",
    ask: defaults.ask ?? "off",
  });
  const effectiveFallback = defaults.bypassHostApprovalFloors === true ? "deny" : askFallback;
  const commandPolicy =
    policy.security === "allowlist" ||
    defaults.strictInlineEval === true ||
    needsDelegatedExecFallbackCommandPolicy({ ...policy, askFallback: effectiveFallback });
  const configuredSafeBins = commandPolicy
    ? [...resolveSafeBins(defaults.safeBins)].toSorted()
    : [];
  const safeBins = configuredSafeBins.filter((name) => !/[/\\]/.test(name));
  const profiles = resolveSafeBinProfiles(defaults.safeBinProfiles);
  const unsupported: DelegatedParameterUnsupported[] = [];
  const nodeAllowed =
    defaults.host === "node" || ((!defaults.host || defaults.host === "auto") && !sandboxed);
  if (nodeAllowed && (defaults.node || defaults.nodeCwd)) {
    unsupported.push({ scope: "exec", reason: "exec-node-binding" });
  }
  if (
    commandPolicy &&
    (defaults.safeBinTrustedDirs?.length || configuredSafeBins.some((name) => /[/\\]/.test(name)))
  ) {
    unsupported.push({ scope: "exec", reason: "exec-trusted-paths" });
  }
  if (
    (policy.ask !== "off" || policy.autoReview) &&
    (defaults.reviewer || defaults.approvalReviewerDeviceId)
  ) {
    unsupported.push({ scope: "exec", reason: "exec-reviewer-binding" });
  }
  return {
    restriction: {
      security: policy.security,
      ask: policy.ask,
      askFallback: effectiveFallback,
      autoReview: policy.autoReview,
      bypassHostApprovalFloors: defaults.bypassHostApprovalFloors === true,
      host: defaults.host ?? "auto",
      elevation:
        defaults.elevated?.enabled && defaults.elevated.allowed
          ? defaults.elevated.defaultLevel === "full"
            ? "full"
            : "ask"
          : "off",
      strictInlineEval:
        defaults.strictInlineEval === true && defaults.bypassHostApprovalFloors !== true,
      safeBins,
      safeBinProfiles: safeBins.flatMap((name) => {
        const profile = profiles[name];
        return profile
          ? [
              {
                name,
                minPositional: profile.minPositional ?? null,
                maxPositional: profile.maxPositional ?? null,
                allowedValueFlags: [...(profile.allowedValueFlags ?? [])].toSorted(),
                allowedBooleanFlags: [...(profile.allowedBooleanFlags ?? [])].toSorted(),
                deniedFlags: [...(profile.deniedFlags ?? [])].toSorted(),
              },
            ]
          : [];
      }),
    },
    unsupported,
  };
}

function canRequireDelegatedExecApproval(
  entry: Pick<DelegatedExecRestriction, "security" | "ask">,
): boolean {
  return requiresExecApproval({
    ...entry,
    analysisOk: false,
    allowlistSatisfied: false,
  });
}

export function needsDelegatedExecFallbackCommandPolicy(
  entry: Pick<DelegatedExecRestriction, "security" | "ask" | "askFallback">,
): boolean {
  return entry.askFallback === "allowlist" && canRequireDelegatedExecApproval(entry);
}

export function needsDelegatedExecCommandPolicy(entry: DelegatedExecRestriction) {
  return entry.security !== "full" || entry.ask !== "off" || entry.strictInlineEval;
}

/** Deliberately incomplete implication proof; resource or command predicates are never sampled. */
export function isDelegatedExecRestrictionSatisfied(
  source: DelegatedExecRestriction,
  target: DelegatedExecRestriction,
): boolean {
  if (target.security === "deny") {
    return true;
  }
  if (source.security === "deny" || (source.host !== "auto" && source.host !== target.host)) {
    return false;
  }
  const elevation = { off: 0, ask: 1, full: 2 };
  if (
    elevation[target.elevation] > elevation[source.elevation] ||
    (!source.bypassHostApprovalFloors && target.bypassHostApprovalFloors) ||
    (source.strictInlineEval && !target.strictInlineEval)
  ) {
    return false;
  }
  if (source.ask === "always" && target.ask !== "always") {
    return false;
  }
  if (canRequireDelegatedExecApproval(source) && canRequireDelegatedExecApproval(target)) {
    const sourceFallback = minSecurity(source.security, source.askFallback);
    const targetFallback = minSecurity(target.security, target.askFallback);
    if (minSecurity(sourceFallback, targetFallback) !== targetFallback) {
      return false;
    }
    if (
      sourceFallback === "allowlist" &&
      targetFallback !== "deny" &&
      (JSON.stringify(source.safeBins) !== JSON.stringify(target.safeBins) ||
        JSON.stringify(source.safeBinProfiles) !== JSON.stringify(target.safeBinProfiles))
    ) {
      return false;
    }
  }
  if (source.security === "full") {
    return true;
  }
  if (
    target.security !== "allowlist" ||
    JSON.stringify(source.safeBins) !== JSON.stringify(target.safeBins) ||
    JSON.stringify(source.safeBinProfiles) !== JSON.stringify(target.safeBinProfiles)
  ) {
    return false;
  }
  if (source.ask === "off") {
    return target.ask === "off";
  }
  return source.autoReview || target.ask === "off" || !target.autoReview;
}

export function assertDelegatedExecTarget(params: {
  restrictions: readonly DelegatedExecRestriction[];
  host: ExecHost;
  elevated: "off" | "ask" | "full";
}): void {
  for (const entry of params.restrictions) {
    if (entry.host !== "auto" && entry.host !== params.host) {
      throw new Error("Exec target does not satisfy the accepted delegation policy.");
    }
    if (
      (entry.elevation === "off" && params.elevated !== "off") ||
      (entry.elevation === "ask" && params.elevated === "full")
    ) {
      throw new Error("Elevated exec does not satisfy the accepted delegation policy.");
    }
    if (
      entry.security !== "deny" &&
      needsDelegatedExecCommandPolicy(entry) &&
      params.host !== "gateway"
    ) {
      throw new Error(
        "Delegated exec approval and command restrictions are unsupported by this backend.",
      );
    }
  }
}

/** Narrow configured defaults; each backend still owns current effect/approval authority. */
export function applyDelegatedExecRestrictions(
  defaults: ExecToolDefaults,
  restrictions: readonly DelegatedExecRestriction[],
  sandboxed: boolean,
): ExecToolDefaults {
  if (!restrictions.length) {
    return defaults;
  }
  const current = captureDelegatedExecRestriction(defaults).restriction;
  const clauses = [current, ...restrictions];
  let host = defaults.sandboxRequired ? "auto" : (defaults.host ?? "auto");
  for (const entry of restrictions) {
    if (entry.host !== "auto") {
      if (host !== "auto" && host !== entry.host) {
        throw new Error("Delegated exec target cannot be applied to the receiver.");
      }
      if (host === "auto" && sandboxed && entry.host !== "sandbox") {
        throw new Error("Delegated exec cannot escape the receiver sandbox.");
      }
      host = entry.host;
    }
  }
  const effectiveHost = host === "auto" ? (sandboxed ? "sandbox" : "gateway") : host;
  assertDelegatedExecTarget({ restrictions, host: effectiveHost, elevated: "off" });
  const security = clauses.reduce(
    (value, entry) => minSecurity(value, entry.security),
    current.security,
  );
  const ask = clauses.reduce((value, entry) => maxAsk(value, entry.ask), current.ask);
  const autoReview =
    current.autoReview &&
    clauses.every((entry) => entry.ask === "off" || (entry.ask === "on-miss" && entry.autoReview));
  const constrained = restrictions.some(needsDelegatedExecCommandPolicy);
  const elevation = clauses.some((entry) => entry.elevation === "off")
    ? "off"
    : clauses.some((entry) => entry.elevation === "ask")
      ? "ask"
      : "full";
  return {
    ...defaults,
    host,
    mode: autoReview && security === "allowlist" && ask === "on-miss" ? "auto" : undefined,
    security,
    ask,
    strictInlineEval: clauses.some((entry) => entry.strictInlineEval),
    bypassHostApprovalFloors:
      constrained || restrictions.some((entry) => !entry.bypassHostApprovalFloors)
        ? false
        : defaults.bypassHostApprovalFloors,
    elevated: defaults.elevated
      ? {
          ...defaults.elevated,
          allowed: defaults.elevated.allowed && elevation !== "off",
          defaultLevel:
            elevation === "full"
              ? defaults.elevated.defaultLevel
              : elevation === "off"
                ? "off"
                : defaults.elevated.defaultLevel === "full"
                  ? "ask"
                  : defaults.elevated.defaultLevel,
        }
      : undefined,
    delegatedRestrictions: [...restrictions],
    delegatedReceiverSecurity: defaults.delegatedReceiverSecurity ?? current.security,
  };
}

/** Each predicate retains its own argv parsing and long-option abbreviation semantics. */
function resolveDelegatedSafeBinPolicy(entry: DelegatedExecRestriction) {
  const safeBins = new Set(entry.safeBins);
  const safeBinProfiles: Record<string, SafeBinProfile> = {};
  for (const name of safeBins) {
    const profile = entry.safeBinProfiles.find((candidate) => candidate.name === name);
    if (!profile) {
      safeBins.delete(name);
      continue;
    }
    safeBinProfiles[name] = {
      minPositional: profile.minPositional ?? undefined,
      maxPositional: profile.maxPositional ?? undefined,
      allowedValueFlags: new Set(profile.allowedValueFlags),
      allowedBooleanFlags: new Set(profile.allowedBooleanFlags),
      deniedFlags: new Set(profile.deniedFlags),
    };
  }
  return { safeBins, safeBinProfiles };
}

export async function evaluateDelegatedExecPolicy(
  params: Parameters<typeof evaluateShellAllowlistWithAuthorization>[0] & {
    restrictions?: readonly DelegatedExecRestriction[];
    receiverSecurity: ExecSecurity;
    receiverAskFallback: ExecSecurity;
  },
) {
  const receiverAllowlistEval = await evaluateShellAllowlistWithAuthorization(params);
  const delegatedEvaluations = (params.restrictions ?? [])
    .filter(
      (restriction) =>
        restriction.security === "allowlist" ||
        needsDelegatedExecFallbackCommandPolicy(restriction),
    )
    .map((restriction) => ({
      restriction,
      evaluation: evaluatePreparedShellAllowlist({
        analysis: receiverAllowlistEval,
        allowlist: [],
        ...resolveDelegatedSafeBinPolicy(restriction),
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
      }),
    }));
  const delegatedCommandEvaluations = delegatedEvaluations.filter(
    ({ restriction }) => restriction.security === "allowlist",
  );
  const delegatedCommandAllowed = delegatedCommandEvaluations.every(
    ({ evaluation }) => evaluation.analysisOk && evaluation.allowlistSatisfied,
  );
  const delegatedApprovalRestrictions = (params.restrictions ?? []).filter((restriction) => {
    const evaluation = delegatedEvaluations.find(
      (entry) => entry.restriction === restriction,
    )?.evaluation;
    return requiresExecApproval({
      security: restriction.security,
      ask: restriction.ask,
      analysisOk: evaluation?.analysisOk ?? false,
      allowlistSatisfied: evaluation?.allowlistSatisfied ?? false,
    });
  });
  // Timeout authority is bounded by the source that actually required approval.
  // A receiver-only prompt must not tighten unrelated source full/off work.
  const askFallback = delegatedApprovalRestrictions.reduce(
    (fallback, restriction) => minSecurity(fallback, restriction.askFallback),
    params.receiverAskFallback,
  );
  const delegatedFallbackAllowed = delegatedApprovalRestrictions.every((restriction) => {
    if (restriction.askFallback !== "allowlist") {
      return true;
    }
    const evaluation = delegatedEvaluations.find(
      (entry) => entry.restriction === restriction,
    )?.evaluation;
    return evaluation?.analysisOk === true && evaluation.allowlistSatisfied;
  });
  return {
    commandAllowed: delegatedCommandAllowed,
    fallbackAllowed: delegatedFallbackAllowed,
    askFallback,
    deniedByOff: delegatedCommandEvaluations.some(
      ({ restriction, evaluation }) =>
        restriction.ask === "off" && (!evaluation.analysisOk || !evaluation.allowlistSatisfied),
    ),
    evaluation:
      params.receiverSecurity === "full"
        ? (delegatedCommandEvaluations[0]?.evaluation ??
          delegatedEvaluations[0]?.evaluation ??
          receiverAllowlistEval)
        : receiverAllowlistEval,
  };
}

/** Timeout fallback requires current policy and an enforceable command, not human approval. */
export function resolveExecAllowlistTimeoutFallback(
  state: {
    baseDecision: { timedOut: boolean };
    approvedByAsk: boolean;
    deniedReason: string | null;
  },
  policy: {
    security: ExecSecurity;
    authorizationSatisfied: boolean;
    planSatisfied: boolean;
  },
) {
  if (!state.baseDecision.timedOut || policy.security !== "allowlist") {
    return state;
  }
  if (!policy.authorizationSatisfied) {
    return {
      ...state,
      approvedByAsk: false,
      deniedReason: "approval-timeout: allowlist-miss",
    };
  }
  if (!policy.planSatisfied) {
    return {
      ...state,
      approvedByAsk: false,
      deniedReason: "approval-timeout: execution-plan-miss",
    };
  }
  return { ...state, approvedByAsk: true, deniedReason: null };
}
