import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { modelPolicyWildcardMatches } from "../config/model-policy-ref.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type {
  OperatorModelPolicySnapshot,
  PreparedOperatorModelPolicy,
  RequesterModelPolicySnapshot,
} from "./operator-model-policy.types.js";

const modelPolicySnapshots = new WeakMap<
  PreparedOperatorModelPolicy,
  {
    snapshot?: OperatorModelPolicySnapshot;
    constraints?: OperatorModelPolicySnapshot[];
    membership: string;
  }
>();

function modelPolicyConstraints(policy: PreparedOperatorModelPolicy) {
  const retained = modelPolicySnapshots.get(policy);
  return retained?.constraints ?? (retained?.snapshot ? [retained.snapshot] : undefined);
}

export function captureRequesterModelPolicySnapshot(
  policy: PreparedOperatorModelPolicy | undefined,
): RequesterModelPolicySnapshot {
  if (!policy) {
    return { kind: "unbounded" };
  }
  const constraints = modelPolicyConstraints(policy);
  return constraints ? { kind: "bounded", constraints } : { kind: "unknown" };
}

/** Missing legacy facts never silently remove a requester ceiling. */
export function restoreRequesterModelPolicySnapshot(
  snapshot: RequesterModelPolicySnapshot | undefined,
): PreparedOperatorModelPolicy | undefined {
  if (
    !snapshot ||
    snapshot.kind === "unknown" ||
    (snapshot.kind === "bounded" && snapshot.constraints.length === 0)
  ) {
    throw new Error(
      "The requester model policy is unavailable; send a new message to resume this session.",
    );
  }
  return snapshot.kind === "unbounded"
    ? undefined
    : snapshot.constraints.reduce<PreparedOperatorModelPolicy | undefined>(
        (policy, constraint) =>
          intersectOperatorModelPolicies(policy, restoreOperatorModelPolicySnapshot(constraint)),
        undefined,
      );
}

/** A restriction can narrow a live policy without retaining its source authority. */
export function intersectOperatorModelPolicies(
  original: PreparedOperatorModelPolicy | undefined,
  current: PreparedOperatorModelPolicy | undefined,
): PreparedOperatorModelPolicy | undefined {
  const membership = readOperatorModelPolicyMembership(original);
  if (
    !original ||
    !current ||
    original === current ||
    (membership !== undefined && membership === readOperatorModelPolicyMembership(current))
  ) {
    return current ?? original;
  }
  const policy = Object.freeze({
    models: Object.freeze(current.models.filter(original.allows)),
    allows: (ref: ModelRef) => original.allows(ref) && current.allows(ref),
  });
  const left = modelPolicyConstraints(original);
  const right = modelPolicyConstraints(current);
  if (left && right) {
    const constraints = [...left, ...right];
    modelPolicySnapshots.set(policy, { constraints, membership: JSON.stringify(constraints) });
  }
  return policy;
}

/** Preserve resolved identities and wildcard predicates, not only discovered default choices. */
export function captureOperatorModelPolicySnapshot(
  policy: PreparedOperatorModelPolicy | undefined,
) {
  return policy ? modelPolicySnapshots.get(policy)?.snapshot : undefined;
}

export function restoreOperatorModelPolicySnapshot(
  snapshot: OperatorModelPolicySnapshot,
): PreparedOperatorModelPolicy {
  const prepare = (refs: OperatorModelPolicySnapshot["allowed"]) => ({
    exact: new Set(refs.exact),
    wildcards: refs.wildcards,
  });
  const captured = freezeJsonSnapshot(structuredClone(snapshot));
  const allowed = prepare(captured.allowed);
  const denied = prepare(captured.denied);
  return recordPreparedOperatorModelPolicy(
    captured,
    (ref) => matchesOperatorModelPolicy(allowed, ref) && !matchesOperatorModelPolicy(denied, ref),
  );
}

export function recordPreparedOperatorModelPolicy(
  captured: OperatorModelPolicySnapshot,
  allows: PreparedOperatorModelPolicy["allows"],
): PreparedOperatorModelPolicy {
  const policy = Object.freeze({ models: captured.models, allows });
  modelPolicySnapshots.set(policy, {
    snapshot: captured,
    membership: JSON.stringify([
      captured.allowed.exact,
      captured.allowed.wildcards,
      captured.denied.exact,
      captured.denied.wildcards,
    ]),
  });
  return policy;
}

/** Comparison uses the original predicate, including models outside concrete discovery choices. */
export function readOperatorModelPolicyMembership(
  policy: PreparedOperatorModelPolicy | undefined,
): string | undefined {
  return policy ? modelPolicySnapshots.get(policy)?.membership : "unrestricted";
}

export function operatorModelPolicyIdentity(ref: ModelRef): string {
  return JSON.stringify([normalizeProviderId(ref.provider), ref.model]);
}

export function matchesOperatorModelPolicy(
  prepared: {
    exact: ReadonlySet<string> | ReadonlyMap<string, ModelRef>;
    wildcards: readonly string[];
  },
  ref: ModelRef,
) {
  const key = `${normalizeProviderId(ref.provider)}/${ref.model}`;
  return (
    prepared.exact.has(operatorModelPolicyIdentity(ref)) ||
    prepared.wildcards.some((wildcard) => modelPolicyWildcardMatches(wildcard, key))
  );
}
