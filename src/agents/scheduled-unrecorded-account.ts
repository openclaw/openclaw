import { recordModelFallbackStop } from "./model-fallback-stop.js";

/**
 * Refuses a scheduled run that records no inference account but would use a stored one.
 * Names the runtime and the account so the operator can record that exact choice.
 */
export function createUnrecordedScheduledAccountRefusal(params: {
  runtime: string;
  /** `provider/model` the run would execute. */
  modelRef: string;
  profileId?: string;
}): Error {
  const account = params.profileId
    ? `stored account ${params.profileId}`
    : "a credential that is not a configured key";
  const refusal = new Error(
    `Automation has no recorded inference account. Runtime ${params.runtime} would run ${params.modelRef} with ${account}. ` +
      `Record the account with openclaw automations edit <jobId> --model ${params.modelRef}@${params.profileId ?? "<profileId>"}.` +
      (params.runtime === "openclaw" || params.runtime === "codex"
        ? " For eligible host-managed accounts, openclaw doctor --fix can record it without pinning the model."
        : ""),
  );
  // Another model would only bypass the operator's account choice.
  recordModelFallbackStop(refusal);
  return refusal;
}
