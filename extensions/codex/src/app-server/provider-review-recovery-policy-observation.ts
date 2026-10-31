import { isDeepStrictEqual } from "node:util";

/**
 * RFC supporting data comparison only; this is NOT recovery authorization.
 * The caller must obtain expected values from the current policy owner and
 * validate the native response with the protocol schema. Neither is implemented
 * by this helper. A match cannot authorize a binding write or acknowledgment.
 */
export const recoveryPolicyObservationFields = [
  "model",
  "modelProvider",
  "cwd",
  "runtimeWorkspaceRoots",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "activePermissionProfile",
] as const;

type Field = (typeof recoveryPolicyObservationFields)[number];

export type ExpectedRecoveryPolicyObservation = Readonly<{
  threadId: string;
  fields: Readonly<Record<Field, unknown>>;
}>;

export type RecoveryPolicyComparison = Readonly<{
  status: "matches_expected_fields" | "unavailable" | "different";
  reason?: string;
  mutationAuthorized: false;
  /** These guarantees MUST come from other trusted owners, never this result. */
  notEstablished: readonly string[];
}>;

const notEstablished = Object.freeze([
  "operator-and-review-authority",
  "exclusive-native-subscription-ownership",
  "effective-configuration-generation",
  "immutable-catalog-provenance-and-executor-authorization",
  "canonical-transaction-fencing",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compareRecoveryPolicyObservation(
  expected: ExpectedRecoveryPolicyObservation,
  response: unknown,
): RecoveryPolicyComparison {
  const result = (
    status: RecoveryPolicyComparison["status"],
    reason?: string,
  ): RecoveryPolicyComparison =>
    Object.freeze({ status, ...(reason ? { reason } : {}), mutationAuthorized: false, notEstablished });

  if (!record(response) || !record(response.thread) || typeof response.thread.id !== "string") {
    return result("unavailable", "native-thread-identity-missing");
  }
  if (response.thread.id !== expected.threadId) {
    return result("different", "native-thread-identity-changed");
  }
  for (const field of recoveryPolicyObservationFields) {
    if (
      !Object.hasOwn(expected.fields, field) ||
      expected.fields[field] === undefined ||
      !Object.hasOwn(response, field) ||
      response[field] === undefined
    ) {
      return result("unavailable", `policy-field-missing:${field}`);
    }
  }
  // The initial recovery contract requires known profile provenance. Null is
  // an explicit unknown in the native protocol, not a permission attestation.
  if (expected.fields.activePermissionProfile === null || response.activePermissionProfile === null) {
    return result("unavailable", "permission-profile-provenance-unknown");
  }
  for (const field of recoveryPolicyObservationFields) {
    if (!isDeepStrictEqual(response[field], expected.fields[field])) {
      return result("different", `policy-field-changed:${field}`);
    }
  }
  return result("matches_expected_fields");
}
