import type { DelegatedToolParameterPolicy } from "../inherited-tool-parameters.types.js";
import type { InheritedToolPolicyV2 } from "../inherited-tool-policy.schema.js";
import { ACTIVE_EMBEDDED_RUNS, ACTIVE_EMBEDDED_RUN_REGISTRATIONS } from "./run-state.js";

/** Read the exact receiving generation without extending its execution lifetime. */
export function captureActiveEmbeddedRunInheritedToolPolicy(sessionId: string): {
  get: () => InheritedToolPolicyV2;
  getEnforcedParameters: () => DelegatedToolParameterPolicy | undefined;
  accept: (policy: InheritedToolPolicyV2) => () => void;
} {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  const authority = registration?.toolAuthority;
  if (!handle || !authority?.getInheritedToolPolicy || !authority.addDelegatedInputPolicies) {
    throw new Error("Target run has no prepared delegation policy.");
  }
  const getPolicy = authority.getInheritedToolPolicy;
  const addPolicies = authority.addDelegatedInputPolicies;
  const assertCurrent = () => {
    authority.assertActive();
    if (
      ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration
    ) {
      throw new Error("Target run delegation authority changed.");
    }
  };
  return {
    get: () => {
      assertCurrent();
      const policy = getPolicy();
      assertCurrent();
      return policy;
    },
    getEnforcedParameters: () => {
      assertCurrent();
      const policy = authority.getEnforcedDelegatedToolParameterPolicy?.();
      assertCurrent();
      return policy;
    },
    accept: (policy) => {
      assertCurrent();
      const release = addPolicies([policy]);
      try {
        assertCurrent();
      } catch (error) {
        release();
        throw error;
      }
      return release;
    },
  };
}

/** Capture only accepted requirements, without reinterpreting the run's configured resources. */
export function captureActiveEmbeddedRunDelegatedToolParameters(
  sessionId: string,
): () => DelegatedToolParameterPolicy {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  const authority = registration?.toolAuthority;
  const get = authority?.getDelegatedToolParameterPolicy;
  if (!handle || !authority || !get) {
    throw new Error("Run has no prepared delegated parameter policy.");
  }
  const assertCurrent = () => {
    authority.assertActive();
    if (
      ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration
    ) {
      throw new Error("Run delegated parameter authority changed.");
    }
  };
  return () => {
    assertCurrent();
    const policy = get();
    assertCurrent();
    return policy;
  };
}
