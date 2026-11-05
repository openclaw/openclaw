import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import { findPersistedAuthProfileCredentialAsync } from "../auth-profiles/store-runtime.js";
import { FailoverError } from "../failover-error.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";

export function createCliCredentialUseCheck(profileId: string, agentDir: string) {
  return async () => {
    if (await findPersistedAuthProfileCredentialAsync({ profileId, agentDir })) {
      return;
    }
    const error = new Error(
      `Saved account "${profileId}" was removed. Select a connected account or sign in again, then retry. OpenClaw did not submit this turn.`,
    );
    error.name = "CliCredentialRemovedError";
    recordModelFallbackStop(error);
    throw error;
  };
}

export function createCliProfileResolutionError(
  backendId: string,
  profileId: string,
  agentDir: string,
) {
  return (provider: string, resolvedProfileId?: string) => {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(provider, { profileId });
    const reason =
      resolvedProfileId !== undefined
        ? `selected auth profile "${profileId}" resolved as "${resolvedProfileId}"`
        : `could not materialize selected auth profile "${profileId}"`;
    return new CliAuthProfilePreparationError({
      message: `CLI backend "${backendId}" ${reason}. Re-authenticate with: ${loginCommand}. OpenClaw did not start the run.`,
      profileId,
      provider,
      agentDir,
    });
  };
}

/** Typed terminal fact for a selected profile that fails before CLI spawn. */
export class CliAuthProfilePreparationError extends FailoverError {
  declare readonly profileId: string;
  declare readonly provider: string;
  readonly agentDir: string;

  constructor(params: {
    message: string;
    profileId: string;
    provider: string;
    agentDir: string;
    cause?: unknown;
  }) {
    super(params.message, {
      reason: "auth",
      provider: params.provider,
      profileId: params.profileId,
      cause: params.cause,
    });
    this.name = "CliAuthProfilePreparationError";
    this.agentDir = params.agentDir;
  }
}
