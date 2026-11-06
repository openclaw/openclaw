import { toErrorObject } from "../../infra/errors.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import { withPersonalAuthProfileStore } from "../auth-profiles/personal-store.js";
import { createEmptyAuthProfileStore } from "../auth-profiles/runtime-snapshot-owner.js";
import { prepareAuthProfileCredentialRead } from "../auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { FailoverError } from "../failover-error.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";

function stopCredentialUse(error: unknown): never {
  const refusal = toErrorObject(error, "Saved CLI account authority is unavailable");
  recordModelFallbackStop(refusal);
  throw refusal;
}

export async function prepareCliCredentialUseCheck(
  profileId: string,
  agentDir: string,
  store: AuthProfileStore = createEmptyAuthProfileStore(),
) {
  try {
    const readCurrentCredential = isUserModelAuthProfileId(profileId)
      ? await withPersonalAuthProfileStore(profileId, async (owner) => {
          await owner.read();
          return owner.readCurrentCredential;
        })
      : await prepareAuthProfileCredentialRead({ profileId, agentDir, store });
    return () => {
      try {
        if (!readCurrentCredential?.()) {
          throw new CliCredentialRemovedError(profileId);
        }
      } catch (error) {
        stopCredentialUse(error);
      }
    };
  } catch (error) {
    return stopCredentialUse(error);
  }
}

function credentialRemovedMessage(profileId?: string): string {
  const account = profileId
    ? isUserModelAuthProfileId(profileId)
      ? "Selected personal account"
      : `Saved account "${profileId}"`
    : "The selected account";
  return `${account} was removed. Select a connected account or sign in again under Models, then retry. OpenClaw did not submit this turn.`;
}

export class CliCredentialRemovedError extends Error {
  constructor(readonly profileId: string) {
    super(credentialRemovedMessage(profileId));
    this.name = "CliCredentialRemovedError";
  }

  userMessage(includeAuthProfileId = false): string {
    return credentialRemovedMessage(includeAuthProfileId ? this.profileId : undefined);
  }
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
