import { isDeepStrictEqual } from "node:util";
import { parseSecretRef } from "../../config/types.secrets.js";
import { toErrorObject } from "../../infra/errors.js";
import { AuthProfileCredentialPublicationPendingError } from "../../state/user-model-account-authority.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import { withPersonalAuthProfileStore } from "../auth-profiles/personal-store.js";
import { createEmptyAuthProfileStore } from "../auth-profiles/runtime-snapshot-owner.js";
import { prepareAuthProfileCredentialRead } from "../auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { FailoverError } from "../failover-error.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";

function stopCredentialUse(error: unknown): never {
  const refusal = toErrorObject(error, "Saved CLI account authority is unavailable");
  recordModelFallbackStop(refusal);
  throw refusal;
}

function hasInlineCredential(credential: AuthProfileCredential | undefined): boolean {
  if (credential?.type === "api_key") {
    return Boolean(credential.key && !credential.keyRef && !parseSecretRef(credential.key));
  }
  return (
    credential?.type === "token" &&
    Boolean(credential.token && !credential.tokenRef && !parseSecretRef(credential.token))
  );
}

export async function prepareCliCredentialUseCheck(
  profileId: string,
  agentDir: string,
  {
    store = createEmptyAuthProfileStore(),
    signal,
    expectedCredential,
  }: {
    store?: AuthProfileStore;
    signal?: AbortSignal;
    expectedCredential?: AuthProfileCredential;
  } = {},
) {
  try {
    const personal = isUserModelAuthProfileId(profileId);
    // OAuth and SecretRefs obtain the bearer from a separate owner.
    const expectedInlineCredential =
      !personal && hasInlineCredential(expectedCredential) ? expectedCredential : undefined;
    const mayWaitForPublication = expectedInlineCredential !== undefined;
    const readCurrentCredential = personal
      ? await withPersonalAuthProfileStore(profileId, async (owner) => {
          await owner.read();
          return owner.readCurrentCredential;
        })
      : await prepareAuthProfileCredentialRead(
          { profileId, agentDir, store },
          mayWaitForPublication ? { signal } : undefined,
        );
    const assertSaved = () => {
      const currentCredential = readCurrentCredential?.();
      if (!currentCredential) {
        throw new CliCredentialRemovedError(profileId);
      }
      if (
        expectedInlineCredential &&
        !isDeepStrictEqual(currentCredential, expectedInlineCredential)
      ) {
        throw new Error(
          "The saved CLI account changed during preparation. Retry with the current account. OpenClaw did not submit this turn.",
        );
      }
    };
    return {
      mayWaitForPublication,
      assertCurrent: () => {
        try {
          assertSaved();
        } catch (error) {
          stopCredentialUse(error);
        }
      },
      async prepareAfter(preparePin: () => Promise<void>, effectSignal?: AbortSignal) {
        for (;;) {
          await preparePin();
          try {
            assertSaved();
            return;
          } catch (error) {
            if (
              !mayWaitForPublication ||
              !(error instanceof AuthProfileCredentialPublicationPendingError)
            ) {
              stopCredentialUse(error);
            }
            // Publication can yield to a new session pin. Re-admit it before retrying.
            await error.waitUntilCurrent(effectSignal).catch(stopCredentialUse);
          }
        }
      },
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
