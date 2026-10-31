import { recordModelFallbackStop } from "./model-fallback-stop.js";

/**
 * Refuses a scheduled run that records no inference account but would use a stored one.
 * Names the runtime and the account so the operator can record that exact choice.
 * The four "never for" cases are the ones Doctor's account pass always skips (see
 * inference-binding-migration.ts); Doctor can also leave a job unrecorded for other reasons.
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
      `Record the account with openclaw automations edit <jobId> --model ${params.modelRef}@${params.profileId ?? "<profileId>"}. ` +
      `openclaw doctor --fix may record it instead, but never for a job that targets the main session, whose primary model uses a CLI runtime, whose runtime is explicitly set to something other than openclaw or auto (by a compatible session runtime override or agentRuntime config), or whose session is model-locked.`,
  );
  // Another model would only bypass the operator's account choice.
  recordModelFallbackStop(refusal);
  return refusal;
}
