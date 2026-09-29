import type { AgentHarness, AgentHarnessIsolatedCompletionAuthorization } from "./harness/types.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import type { PreparedAgentRuntimeAuthAttempt } from "./runtime-plan/prepare-auth.js";

/** Hands usable host credentials only to the selected external completion owner. */
export function prepareIsolatedHostAuthorization<
  T extends Pick<
    Extract<AgentHarnessIsolatedCompletionAuthorization, { owner: "host" }>,
    "model" | "auth"
  >,
>(harness: AgentHarness, authorization: T): T {
  if (harness.id === "openclaw") {
    return authorization;
  }
  // External harnesses are the provider egress boundary. Keep credentials
  // sentinelized until this owner is selected, then hand it usable values.
  const boundary = "plugin harness isolated completion handoff";
  const apiKey = authorization.auth.apiKey
    ? unwrapSecretSentinelsForProviderEgress(authorization.auth.apiKey, boundary)
    : authorization.auth.apiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(authorization.model, boundary);
  if (apiKey === authorization.auth.apiKey && model === authorization.model) {
    return authorization;
  }
  return {
    ...authorization,
    model,
    auth: { ...authorization.auth, apiKey },
  };
}

/** Limits one completion to the credential candidate selected by core. */
export function selectIsolatedHarnessAuthPlan(attempt: PreparedAgentRuntimeAuthAttempt) {
  if (attempt.kind !== "profile") {
    return attempt.plan;
  }
  return {
    ...attempt.plan,
    forwardedAuthProfileId: attempt.profileId,
    // Core owns candidate order. A harness receives one selected credential
    // snapshot per call so it cannot inspect or reorder fallback profiles.
    forwardedAuthProfileCandidateIds: [attempt.profileId],
  };
}
