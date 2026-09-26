/**
 * Auth profile policy validation.
 * Rejects SecretRef-backed OAuth material because OAuth credentials are mutable
 * runtime state and must stay directly persisted by refresh flows.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef, resolveSecretInputRef } from "../../config/types.secrets.js";
import type { AuthProfileStore } from "./types.js";

type OAuthSecretRefPolicyViolation = {
  path: string;
  reason: string;
};

function collectOAuthSecretRefPolicyViolations(params: {
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  profileIds?: Iterable<string>;
}): OAuthSecretRefPolicyViolation[] {
  const defaults = params.cfg?.secrets?.defaults;
  const profileFilter = params.profileIds ? new Set(params.profileIds) : null;
  const violations: OAuthSecretRefPolicyViolation[] = [];
  for (const [profileId, credential] of Object.entries(params.store.profiles)) {
    if (profileFilter && !profileFilter.has(profileId)) {
      continue;
    }
    // OAuth credentials mutate during refresh, so their material cannot live in SecretRefs.
    if (credential.type === "oauth") {
      const record = credential as Record<string, unknown>;
      for (const field of ["access", "refresh", "token", "tokenRef", "key", "keyRef"] as const) {
        if (coerceSecretRef(record[field], defaults) !== null) {
          violations.push({
            path: `profiles.${profileId}.${field}`,
            reason:
              'SecretRef is not allowed for type="oauth" auth profiles (OAuth credentials are runtime-mutable).',
          });
        }
      }
      continue;
    }
    if (
      params.cfg?.auth?.profiles?.[profileId]?.mode !== "oauth" ||
      (credential.type !== "api_key" && credential.type !== "token")
    ) {
      continue;
    }
    const input =
      credential.type === "api_key"
        ? { field: "key", value: credential.key, refValue: credential.keyRef }
        : { field: "token", value: credential.token, refValue: credential.tokenRef };
    if (resolveSecretInputRef({ ...input, defaults }).ref !== null) {
      violations.push({
        path: `profiles.${profileId}.${input.field}`,
        reason:
          `SecretRef is not allowed when auth.profiles.${profileId}.mode is "oauth" ` +
          "(OAuth credentials are runtime-mutable).",
      });
    }
  }
  return violations;
}

/** Throws when OAuth profiles contain unsupported SecretRef fields. */
export function assertNoOAuthSecretRefPolicyViolations(params: {
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  profileIds?: Iterable<string>;
  context?: string;
}): void {
  const violations = collectOAuthSecretRefPolicyViolations(params);
  if (violations.length === 0) {
    return;
  }
  const lines = [
    `${params.context ?? "auth-profiles"} policy validation failed: OAuth + SecretRef is not supported.`,
    ...violations.map((violation) => `- ${violation.path}: ${violation.reason}`),
  ];
  throw new Error(lines.join("\n"));
}
