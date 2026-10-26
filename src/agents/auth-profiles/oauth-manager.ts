/**
 * OAuth credential manager.
 * Resolves usable access tokens, refreshes expired credentials under global
 * locks, adopts safer main-store credentials, and mirrors refreshed tokens.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS, authProfilesLog } from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { resolveEffectiveOAuthCredentialCore } from "./effective-oauth.js";
import {
  isPersistedExternalCliAuthProfile,
  readExternalCliBootstrapCredential,
} from "./external-cli-sync.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { canRefreshOAuthCredential, refreshOAuthCredential } from "./oauth-provider-operations.js";
import {
  OAuthManagerRefreshError,
  OAuthRefreshFailureError,
  appendOAuthRefreshCleanupErrors,
  isTransientOAuthRefreshFailure,
  markOAuthRefreshFailureSettled,
} from "./oauth-refresh-failure.js";
import {
  isExactOAuthCredential,
  observeOAuthRefreshFenceSettlement,
  observeOAuthRefreshSettlement,
} from "./oauth-refresh-fence.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import {
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
  isSameOAuthRefreshGeneration,
} from "./oauth-refresh-marker.js";
import { beginOAuthRefreshObservation } from "./oauth-refresh-observation.js";
import {
  failOAuthRefreshPeerClaims,
  fenceOAuthRefreshPeers,
  mergeOAuthRefreshPeerClaims,
  OAuthRefreshPeerFenceError,
  rollbackOAuthRefreshPeerClaims,
  settleOAuthRefreshPeerClaims,
  type OAuthRefreshPeerClaim,
} from "./oauth-refresh-peers.js";
import { createOAuthRefreshQueue, type OAuthRefreshCohort } from "./oauth-refresh-queue.js";
import {
  isSafeOAuthOwnerRefreshResult,
  isSafeOAuthPostClaimSettlement,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "./oauth-shared.js";
import {
  adoptNewerMainOAuthCredential,
  buildValidatedOAuthAccess,
  OAuthSettlementCredentialValidationError,
  validateSettlementCredential,
  canReuseOAuthCredentialAfterRefreshFailure,
  loadStoredOAuthRefreshStore,
  markOAuthRefreshClaimFailed,
  persistOAuthRefreshClaim,
  rollbackOAuthRefreshOwnerClaim,
  rollbackTransientOAuthRefreshClaim,
  resolveAuthoritativeSharedOAuthCredentialUnderLock,
  settleOAuthRefreshClaim,
  type OAuthRefreshClaim,
  type OAuthRefreshFailureSettlement,
  type ResolvedOAuthAccess,
} from "./oauth-store.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";
import { withPersonalAuthProfileStore, type PersonalAuthProfileStore } from "./personal-store.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
} from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";
import { runAuthProfileUsage } from "./usage-lifecycle.js";

const oauthRefreshRecoveryBuildFailures = new WeakSet<Error>();

type OAuthRefreshParams = {
  cohort: OAuthRefreshCohort;
  personalStore?: PersonalAuthProfileStore;
  profileId: string;
  provider: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  signal?: AbortSignal;
  forceRefresh?: boolean;
  attemptedCredential: OAuthCredential;
  attemptedCredentials?: OAuthCredential[];
  bootstrapCredential?: OAuthCredential | null;
  bootstrapBaseCredential?: OAuthCredential;
  validateCredential?: (credential: OAuthCredential) => void;
};

/** Create an independent OAuth refresh queue using the native provider operations. */
export function createOAuthManager() {
  const refreshQueue = createOAuthRefreshQueue();

  async function settlePeerClaimsUnderRefreshLock(params: {
    claim: Extract<OAuthRefreshClaim, { kind: "claimed" }>;
    claims: readonly OAuthRefreshPeerClaim[];
    replacement: OAuthCredential;
    validateCredential?: (credential: OAuthCredential) => void;
  }): Promise<void> {
    validateSettlementCredential(params.validateCredential, params.replacement);
    if (params.claim.personalStore) {
      return;
    }
    const authoritativeSharedCredential =
      params.claim.authPath === resolveSharedAuthStorePath()
        ? params.replacement
        : await resolveAuthoritativeSharedOAuthCredentialUnderLock({
            profileId: params.claim.profileId,
            candidate: params.replacement,
            validateCredential: params.validateCredential,
          });
    await settleOAuthRefreshPeerClaims({
      profileId: params.claim.profileId,
      fence: params.claim.fence,
      claims: params.claims,
      authoritativeSharedCredential,
      replacement: params.replacement,
    });
  }

  async function claimOAuthRefresh(params: OAuthRefreshParams): Promise<OAuthRefreshClaim> {
    const personalProfile = isUserModelAuthProfileId(params.profileId);
    const ownerAgentDir = personalProfile
      ? undefined
      : await resolvePersistedAuthProfileOwnerAgentDirAsync(params);
    const authPath =
      params.personalStore?.databasePath ??
      (ownerAgentDir
        ? resolveAuthProfileDatabasePath(ownerAgentDir)
        : resolveSharedAuthStorePath());
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);
    const peerConfig = params.cfg ?? {};
    const failTerminalPeers = async (credential: OAuthCredential) => {
      const claims = personalProfile
        ? []
        : await fenceOAuthRefreshPeers({
            cfg: peerConfig,
            ownerDatabasePath: authPath,
            profileId: params.profileId,
            generation: credential,
            fence: credential,
          });
      await failOAuthRefreshPeerClaims({ profileId: params.profileId, fence: credential, claims });
    };

    let observation: ReturnType<typeof beginOAuthRefreshObservation> | undefined;
    let observationTransferred = false;

    try {
      const claim = await withOAuthProfileLock<OAuthRefreshClaim>(
        { provider: params.provider, profileId: params.profileId },
        async () => {
          params.signal?.throwIfAborted();
          const store = await loadStoredOAuthRefreshStore(
            ownerAgentDir,
            params.profileId,
            params.personalStore,
          );
          const cred = store.profiles[params.profileId];
          if (!cred || cred.type !== "oauth" || cred.provider !== params.provider) {
            return { kind: "unavailable" };
          }
          const storedFence = isOAuthRefreshFence(cred);
          if (!storedFence) {
            params.validateCredential?.(cred);
          }
          let credentialToRefresh = cred;
          if (
            !storedFence &&
            !personalProfile &&
            isPersistedExternalCliAuthProfile({
              profileId: params.profileId,
              credential: cred,
            })
          ) {
            authProfilesLog.warn(
              "refused native OAuth refresh for an externally owned credential",
              {
                profileId: params.profileId,
                provider: cred.provider,
              },
            );
            return { kind: "unavailable" };
          }

          if (
            params.forceRefresh &&
            hasUsableOAuthCredential(cred) &&
            canReuseOAuthCredentialAfterRefreshFailure({
              forceRefresh: true,
              attempted: params.attemptedCredential,
              candidate: cred,
            })
          ) {
            return { kind: "use", credential: cred };
          }
          if (!storedFence && !params.forceRefresh && hasUsableOAuthCredential(cred)) {
            return { kind: "use", credential: cred };
          }

          if (!storedFence && params.agentDir && !personalProfile) {
            try {
              const mainStore = await loadStoredOAuthRefreshStore(undefined);
              const mainCred = mainStore.profiles[params.profileId];
              if (
                ownerAgentDir &&
                mainCred?.type === "oauth" &&
                isSameOAuthRefreshGeneration({
                  profileId: params.profileId,
                  left: cred,
                  right: mainCred,
                })
              ) {
                // The main store owns copied refresh generations. A stale owner
                // resolution must fail closed instead of claiming the local copy.
                return { kind: "unavailable" };
              }
              if (
                mainCred?.type === "oauth" &&
                mainCred.provider === cred.provider &&
                hasUsableOAuthCredential(mainCred) &&
                !params.forceRefresh &&
                isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
              ) {
                params.validateCredential?.(mainCred);
                authProfilesLog.info(
                  "adopted fresh OAuth credential from main store (under refresh lock)",
                  {
                    profileId: params.profileId,
                    agentDir: params.agentDir,
                    expires: new Date(mainCred.expires).toISOString(),
                  },
                );
                return { kind: "use", credential: mainCred };
              } else if (
                mainCred?.type === "oauth" &&
                mainCred.provider === cred.provider &&
                hasUsableOAuthCredential(mainCred) &&
                !isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
              ) {
                authProfilesLog.warn(
                  "refused to adopt fresh main-store OAuth credential: identity mismatch",
                  {
                    profileId: params.profileId,
                    agentDir: params.agentDir,
                  },
                );
              }
            } catch (err) {
              authProfilesLog.debug(
                "inside-lock main-store adoption failed; proceeding to refresh",
                {
                  profileId: params.profileId,
                  error: formatErrorMessage(err),
                },
              );
            }
          }

          const externallyManaged =
            !personalProfile &&
            params.bootstrapCredential &&
            params.bootstrapBaseCredential &&
            isExactOAuthCredential(cred, params.bootstrapBaseCredential)
              ? params.bootstrapCredential
              : null;
          if (externallyManaged) {
            if (externallyManaged.provider !== cred.provider) {
              authProfilesLog.warn(
                "refused external oauth bootstrap credential: provider mismatch",
                {
                  profileId: params.profileId,
                  provider: cred.provider,
                },
              );
            } else if (
              storedFence ||
              !isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)
            ) {
              authProfilesLog.warn(
                "refused external oauth bootstrap credential: fenced or identity mismatch",
                {
                  profileId: params.profileId,
                  provider: cred.provider,
                },
              );
            } else {
              credentialToRefresh = externallyManaged;
              params.validateCredential?.(credentialToRefresh);
              if (!params.forceRefresh && hasUsableOAuthCredential(externallyManaged)) {
                return { kind: "use", credential: externallyManaged };
              }
            }
          }

          if (storedFence && credentialToRefresh === cred) {
            if (isPendingOAuthRefreshFence(cred)) {
              return { kind: "observe", ownerAgentDir, generation: cred };
            }
            await failTerminalPeers(cred);
            return { kind: "unavailable" };
          }
          if (normalizeSecretInputString(credentialToRefresh.refresh) === undefined) {
            return { kind: "unavailable" };
          }
          if (!(await canRefreshOAuthCredential(credentialToRefresh.provider, params.cfg))) {
            return { kind: "unavailable" };
          }

          // Use/observe/bootstrap adoption need no new refresh authority or cohort admission.
          const assertPersonalRefreshCurrent =
            await params.personalStore?.captureRefreshAuthority();
          params.signal?.throwIfAborted();
          assertPersonalRefreshCurrent?.();
          params.cohort.assertNoFailure(authPath, credentialToRefresh);
          const fence = createOAuthRefreshFence({
            profileId: params.profileId,
            credential: credentialToRefresh,
          });
          observation = beginOAuthRefreshObservation();
          const claimed = await persistOAuthRefreshClaim({
            personalStore: params.personalStore,
            assertCurrent: () => {
              params.signal?.throwIfAborted();
              assertPersonalRefreshCurrent?.();
              params.validateCredential?.(credentialToRefresh);
            },
            agentDir: ownerAgentDir,
            profileId: params.profileId,
            expected: cred,
            fence,
          });
          if (!claimed) {
            const current = (
              await loadStoredOAuthRefreshStore(
                ownerAgentDir,
                params.profileId,
                params.personalStore,
              )
            ).profiles[params.profileId];
            if (current?.type !== "oauth" || current.provider !== params.provider) {
              return { kind: "unavailable" };
            }
            if (!isOAuthRefreshFence(current)) {
              params.validateCredential?.(current);
            }
            if (isPendingOAuthRefreshFence(current)) {
              return {
                kind: "observe",
                ownerAgentDir,
                generation: current,
              };
            }
            if (isOAuthRefreshFence(current)) {
              await failTerminalPeers(current);
              return { kind: "unavailable" };
            }
            return hasUsableOAuthCredential(current)
              ? { kind: "use", credential: current }
              : { kind: "unavailable" };
          }
          let peerClaims: OAuthRefreshPeerClaim[] = [];
          const peerGeneration =
            !personalProfile && credentialToRefresh === cred ? cred : undefined;
          try {
            if (!personalProfile && peerGeneration) {
              peerClaims = await fenceOAuthRefreshPeers({
                cfg: peerConfig,
                ownerDatabasePath: authPath,
                profileId: params.profileId,
                generation: peerGeneration,
                fence,
                rollbackOnFailure: false,
              });
            }
          } catch (error) {
            if (error instanceof OAuthRefreshPeerFenceError) {
              peerClaims = mergeOAuthRefreshPeerClaims(peerClaims, error.claims);
            }
            const cleanupErrors: unknown[] = [];
            try {
              await rollbackOAuthRefreshPeerClaims({
                profileId: params.profileId,
                fence,
                claims: peerClaims,
              });
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            try {
              await rollbackOAuthRefreshOwnerClaim({
                personalStore: params.personalStore,
                ownerAgentDir,
                profileId: params.profileId,
                fence,
                original: cred,
              });
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            if (cleanupErrors.length > 0) {
              throw new AggregateError(
                [error, ...cleanupErrors],
                "Failed to claim OAuth refresh ownership and roll back partial claims.",
                { cause: error },
              );
            }
            throw error;
          }
          return {
            kind: "claimed",
            personalStore: params.personalStore,
            profileId: params.profileId,
            credential: credentialToRefresh,
            storedCredential: cred,
            assertPersonalRefreshCurrent,
            fence,
            ownerAgentDir,
            authPath,
            peerClaims,
            ...(peerGeneration ? { peerGeneration } : {}),
            observation,
          };
        },
      );
      observationTransferred = claim.kind === "claimed";
      return claim;
    } catch (error) {
      if (isGlobalRefreshLockTimeoutError(error, globalRefreshLockPath)) {
        throw buildRefreshContentionError({
          provider: params.provider,
          profileId: params.profileId,
          cause: error,
        });
      }
      throw error;
    } finally {
      if (!observationTransferred) {
        observation?.finish();
      }
    }
  }

  async function refreshOAuthTokenWithLock(
    params: OAuthRefreshParams,
  ): Promise<ResolvedOAuthAccess | null> {
    params.signal?.throwIfAborted();
    const claim = await claimOAuthRefresh(params);
    if (claim.kind === "unavailable") {
      return null;
    }
    if (claim.kind === "observe") {
      const observed = await observeOAuthRefreshFenceSettlement({
        label: `refreshOAuthCredential(${params.provider})`,
        timeoutMs: OAUTH_REFRESH_CALL_TIMEOUT_MS,
        signal: params.signal,
        read: async () =>
          (
            await loadStoredOAuthRefreshStore(
              claim.ownerAgentDir,
              params.profileId,
              params.personalStore,
            )
          ).profiles[params.profileId],
        isPending: (credential) =>
          credential?.type === "oauth" &&
          credential.provider === claim.generation.provider &&
          isPendingOAuthRefreshFence(credential),
        resolve: async (credential) => {
          if (
            credential?.type !== "oauth" ||
            !isSafeOAuthPostClaimSettlement(claim.generation, credential)
          ) {
            return null;
          }
          return await buildValidatedOAuthAccess(credential, params);
        },
      });
      return observed;
    }
    if (claim.kind === "use") {
      return await buildValidatedOAuthAccess(claim.credential, params);
    }

    params.attemptedCredentials?.push(claim.credential);
    const peerConfig = params.cfg ?? {};
    let activePeerClaims = claim.peerClaims;

    const failPeers = async (onFailure: (error: unknown) => void) => {
      try {
        await failOAuthRefreshPeerClaims({
          profileId: params.profileId,
          fence: claim.fence,
          claims: activePeerClaims,
        });
      } catch (error) {
        onFailure(error);
      }
    };

    const rediscoverPeerClaims = async (generation: OAuthCredential) => {
      try {
        activePeerClaims = mergeOAuthRefreshPeerClaims(
          activePeerClaims,
          await fenceOAuthRefreshPeers({
            cfg: peerConfig,
            ownerDatabasePath: claim.authPath,
            profileId: params.profileId,
            generation,
            fence: claim.fence,
            rollbackOnFailure: false,
          }),
        );
      } catch (error) {
        if (error instanceof OAuthRefreshPeerFenceError) {
          activePeerClaims = mergeOAuthRefreshPeerClaims(activePeerClaims, error.claims);
        }
        throw error;
      }
    };

    const assertCurrent = () =>
      validateSettlementCredential(() => {
        claim.assertPersonalRefreshCurrent?.();
        params.validateCredential?.(claim.credential);
      }, claim.credential);
    const failClaim = async (
      rediscoverPeers: boolean,
      retryable: boolean,
    ): Promise<OAuthRefreshFailureSettlement> => {
      let result: OAuthRefreshFailureSettlement = {
        supersedingOwner: null,
        validationError: null,
        cleanupErrors: [],
      };
      try {
        await withOAuthProfileLock(
          { provider: params.provider, profileId: params.profileId },
          async () => {
            const cleanupErrors: unknown[] = [];
            let supersedingOwner: OAuthCredential | null = null;
            let validationError: OAuthSettlementCredentialValidationError | null = null;
            try {
              const owner = rediscoverPeers
                ? (
                    await loadStoredOAuthRefreshStore(
                      claim.ownerAgentDir,
                      params.profileId,
                      params.personalStore,
                    )
                  ).profiles[params.profileId]
                : undefined;
              if (retryable) {
                assertCurrent();
              }
              supersedingOwner =
                owner?.type === "oauth" &&
                !isExactOAuthCredential(owner, claim.fence) &&
                isSafeOAuthPostClaimSettlement(claim.credential, owner) &&
                canReuseOAuthCredentialAfterRefreshFailure({
                  forceRefresh: params.forceRefresh,
                  attempted: claim.credential,
                  candidate: owner,
                })
                  ? owner
                  : null;
            } catch (error) {
              cleanupErrors.push(error);
            }
            if (rediscoverPeers && claim.peerGeneration) {
              try {
                await rediscoverPeerClaims(claim.peerGeneration);
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
            if (supersedingOwner && cleanupErrors.length === 0) {
              try {
                await settlePeerClaimsUnderRefreshLock({
                  claim,
                  claims: activePeerClaims,
                  replacement: supersedingOwner,
                  validateCredential: params.validateCredential,
                });
                result = { supersedingOwner, validationError, cleanupErrors };
                return;
              } catch (error) {
                if (error instanceof OAuthSettlementCredentialValidationError) {
                  validationError = error;
                } else {
                  cleanupErrors.push(error);
                }
              }
            }
            if (retryable && !validationError) {
              try {
                cleanupErrors.push(
                  ...(await rollbackTransientOAuthRefreshClaim(
                    claim,
                    activePeerClaims,
                    assertCurrent,
                  )),
                );
                result = { supersedingOwner: null, validationError, cleanupErrors };
                return;
              } catch (error) {
                if (error instanceof OAuthSettlementCredentialValidationError) {
                  validationError = error;
                } else {
                  cleanupErrors.push(error);
                }
              }
            }
            await failPeers((error) => cleanupErrors.push(error));
            try {
              await markOAuthRefreshClaimFailed({
                personalStore: params.personalStore,
                agentDir: claim.ownerAgentDir,
                profileId: params.profileId,
                fence: claim.fence,
              });
            } catch (error) {
              cleanupErrors.push(error);
            }
            result = { supersedingOwner: null, validationError, cleanupErrors };
          },
        );
        return result;
      } catch (error) {
        return {
          supersedingOwner: null,
          validationError: result.validationError,
          cleanupErrors: [...result.cleanupErrors, error],
        };
      }
    };

    const settleFailure = async (failure?: {
      error: unknown;
      externalRefresh?: boolean;
      rediscoverPeers?: false;
    }): Promise<ResolvedOAuthAccess | null> => {
      const initiatingError = failure
        ? toErrorObject(failure.error, "OAuth refresh failed")
        : undefined;
      const retryable =
        failure?.externalRefresh === true && isTransientOAuthRefreshFailure(failure.error);
      const { supersedingOwner, validationError, cleanupErrors } = await failClaim(
        failure?.rediscoverPeers !== false,
        retryable,
      );
      if (validationError) {
        throw new OAuthSettlementCredentialValidationError(validationError, cleanupErrors);
      }
      if (supersedingOwner) {
        try {
          return await buildValidatedOAuthAccess(supersedingOwner, params);
        } catch (error) {
          const combinedFailure =
            initiatingError !== undefined
              ? appendOAuthRefreshCleanupErrors(initiatingError, [...cleanupErrors, error])
              : appendOAuthRefreshCleanupErrors(error, cleanupErrors);
          oauthRefreshRecoveryBuildFailures.add(combinedFailure);
          throw combinedFailure;
        }
      }
      if (initiatingError !== undefined) {
        const error = appendOAuthRefreshCleanupErrors(initiatingError, cleanupErrors);
        if (failure?.externalRefresh && cleanupErrors.length === 0) {
          const settled = new OAuthRefreshFailureError({
            provider: params.provider,
            profileId: params.profileId,
            message: error.message,
            cause: error,
            retryable,
          });
          markOAuthRefreshFailureSettled(settled, error);
          if (retryable) {
            params.cohort.fail(claim.authPath, claim.credential, settled);
          }
          throw settled;
        }
        throw error;
      }
      if (cleanupErrors.length === 0) {
        return null;
      }
      throw appendOAuthRefreshCleanupErrors(cleanupErrors[0], cleanupErrors.slice(1));
    };

    const settlement = runAuthProfileUsage(async (): Promise<ResolvedOAuthAccess | null> => {
      let refreshed: OAuthCredentials | null;
      try {
        refreshed = await refreshOAuthCredential(
          params.personalStore ? structuredClone(claim.credential) : claim.credential,
          {
            cfg: params.cfg,
          },
        );
      } catch (error) {
        return await settleFailure({ error, externalRefresh: true });
      }
      if (!refreshed) {
        return await settleFailure();
      }
      try {
        const rotated = {
          ...claim.credential,
          ...(params.personalStore ? structuredClone(refreshed) : refreshed),
          type: "oauth",
        } satisfies OAuthCredential;
        if (!hasUsableOAuthCredential(rotated, { refreshMarginMs: 0 })) {
          throw new Error("OAuth refresh returned an unusable credential");
        }
        if (!isSafeOAuthOwnerRefreshResult(claim.credential, rotated)) {
          throw new Error("OAuth refresh returned credentials for a different OAuth account");
        }
        params.validateCredential?.(rotated);
        const settled = await withOAuthProfileLock(
          { provider: params.provider, profileId: params.profileId },
          async () => {
            if (claim.peerGeneration) {
              await rediscoverPeerClaims(claim.peerGeneration);
            }
            const claimSettlement = await settleOAuthRefreshClaim({
              personalStore: params.personalStore,
              agentDir: claim.ownerAgentDir,
              profileId: params.profileId,
              generation: claim.credential,
              fence: claim.fence,
              refreshed: rotated,
              validateCredential: params.validateCredential,
            });
            if (!claimSettlement) {
              return null;
            }
            try {
              await settlePeerClaimsUnderRefreshLock({
                claim,
                claims: activePeerClaims,
                replacement: claimSettlement.credential,
                validateCredential: params.validateCredential,
              });
            } catch (peerSettlementError) {
              if (peerSettlementError instanceof OAuthSettlementCredentialValidationError) {
                const cleanupErrors: unknown[] = [];
                await failPeers((error) => cleanupErrors.push(error));
                if (claimSettlement.persisted) {
                  try {
                    await markOAuthRefreshClaimFailed({
                      personalStore: params.personalStore,
                      agentDir: claim.ownerAgentDir,
                      profileId: params.profileId,
                      fence: claim.fence,
                      settledCredential: claimSettlement.credential,
                    });
                  } catch (error) {
                    cleanupErrors.push(error);
                  }
                }
                throw new OAuthSettlementCredentialValidationError(
                  peerSettlementError,
                  cleanupErrors,
                );
              }
              await failPeers((error) => {
                authProfilesLog.warn("failed to terminally fence an OAuth refresh peer", {
                  profileId: params.profileId,
                  error: formatErrorMessage(error),
                });
              });
              authProfilesLog.warn("OAuth refresh peer settlement degraded", {
                profileId: params.profileId,
                error: formatErrorMessage(peerSettlementError),
              });
            }
            return claimSettlement;
          },
        );
        if (!settled) {
          throw new Error("Failed to persist refreshed OAuth credential");
        }
        if (!params.personalStore) {
          observeCanonicalAuthProfileCredentials(claim.authPath, {
            [params.profileId]: settled.credential,
          });
        }
        return await buildValidatedOAuthAccess(settled.credential, params);
      } catch (error) {
        if (error instanceof OAuthRefreshPeerFenceError && hasSqliteWorkerOutcomeUnknown(error)) {
          // The owner commit has not started. Settle exact captured fences without
          // replaying the uncertain peer pass or the consumed provider refresh.
          return await settleFailure({ error, rediscoverPeers: false });
        }
        if (
          error instanceof OAuthSettlementCredentialValidationError ||
          hasSqliteWorkerOutcomeUnknown(error)
        ) {
          throw error;
        }
        return await settleFailure({ error });
      }
    });
    // The caller deadline observes the owner; it never cancels durable settlement.
    void settlement.then(claim.observation.finish, claim.observation.finish);
    return await observeOAuthRefreshSettlement(
      `refreshOAuthCredential(${claim.credential.provider})`,
      OAUTH_REFRESH_CALL_TIMEOUT_MS,
      settlement,
      params.signal,
    );
  }

  async function resolveOAuthAccess(params: {
    personalStore?: PersonalAuthProfileStore;
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
    signal?: AbortSignal;
    forceRefresh?: boolean;
    validateCredential?: (credential: OAuthCredential) => void;
  }): Promise<ResolvedOAuthAccess | null> {
    params.signal?.throwIfAborted();
    if (!isUserModelAuthProfileId(params.profileId)) {
      return resolveOwnedOAuthAccess(params);
    }
    const validateCredential = params.validateCredential;
    // Validators can retain their arguments while the owner awaits provider or worker results.
    const prepared = {
      ...params,
      validateCredential: validateCredential
        ? (credential: OAuthCredential) => validateCredential(structuredClone(credential))
        : undefined,
    };
    const resolve = (personalStore: PersonalAuthProfileStore) =>
      resolveOwnedOAuthAccess({ ...prepared, personalStore });
    return prepared.personalStore
      ? resolve(prepared.personalStore)
      : ((await withPersonalAuthProfileStore(prepared.profileId, async (owner) => {
          await owner.read();
          return resolve(owner);
        })) ?? null);
  }

  async function resolveOwnedOAuthAccess(
    params: Parameters<typeof resolveOAuthAccess>[0],
  ): Promise<ResolvedOAuthAccess | null> {
    params.signal?.throwIfAborted();
    const personalProfile = isUserModelAuthProfileId(params.profileId);
    let credential = params.credential;
    if (params.personalStore) {
      const owned = params.personalStore.readCurrentCredential();
      if (owned?.type !== "oauth") {
        return null;
      }
      credential = owned;
    }
    const newerMainCredential = await adoptNewerMainOAuthCredential({
      profileId: params.profileId,
      agentDir: params.agentDir,
      credential,
    });
    if (newerMainCredential) {
      params.validateCredential?.(newerMainCredential);
      params.store.profiles[params.profileId] = { ...newerMainCredential };
      authProfilesLog.info("adopted newer OAuth credentials from main agent", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(newerMainCredential.expires).toISOString(),
      });
    }
    const adoptedCredential = newerMainCredential ?? credential;
    const bootstrapCredential = personalProfile
      ? null
      : readExternalCliBootstrapCredential({
          profileId: params.profileId,
          credential: adoptedCredential,
        });
    const effectiveCredential = resolveEffectiveOAuthCredentialCore({
      profileId: params.profileId,
      credential: adoptedCredential,
      readBootstrapCredential: () => bootstrapCredential,
    });
    const attemptedCredentials: OAuthCredential[] = [];

    if (
      !params.forceRefresh &&
      !isOAuthRefreshFence(adoptedCredential) &&
      hasUsableOAuthCredential(effectiveCredential)
    ) {
      return await buildValidatedOAuthAccess(effectiveCredential, params);
    }

    try {
      const queued = runAuthProfileUsage(() =>
        refreshQueue.enqueue(credential.provider, params.profileId, (cohort) =>
          refreshOAuthTokenWithLock({
            ...params,
            cohort,
            provider: credential.provider,
            attemptedCredential: effectiveCredential,
            attemptedCredentials,
            bootstrapCredential,
            bootstrapBaseCredential: adoptedCredential,
          }),
        ),
      );
      // The queue retains admission and claim cleanup after this caller stops observing.
      // Claimed refreshes transfer to durable settlement before their queue task exits.
      const resolved = await racePromiseWithAbortSignal(queued, params.signal);
      params.signal?.throwIfAborted();
      return resolved;
    } catch (error) {
      params.signal?.throwIfAborted();
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      let refreshError: unknown = error;
      let recoveryBuildFailed =
        refreshError instanceof OAuthSettlementCredentialValidationError ||
        (refreshError instanceof Error && oauthRefreshRecoveryBuildFailures.has(refreshError));
      let refreshedStore = params.store;
      let recoveryStoreLoaded = false;
      const buildRecoveryAccess = async (
        candidate: OAuthCredential,
      ): Promise<ResolvedOAuthAccess | null> => {
        try {
          return await buildValidatedOAuthAccess(candidate, params);
        } catch (cleanupError) {
          refreshError = appendOAuthRefreshCleanupErrors(refreshError, [cleanupError]);
          recoveryBuildFailed = true;
          return null;
        }
      };
      try {
        refreshedStore = await loadStoredOAuthRefreshStore(
          params.agentDir,
          params.profileId,
          params.personalStore,
        );
        recoveryStoreLoaded = true;
      } catch (cleanupError) {
        refreshError = appendOAuthRefreshCleanupErrors(refreshError, [cleanupError]);
      }
      const claimedGeneration = attemptedCredentials.at(-1) ?? effectiveCredential;
      const canRecover = (
        candidate: AuthProfileStore["profiles"][string] | undefined,
      ): candidate is OAuthCredential =>
        candidate?.type === "oauth" &&
        isSafeOAuthPostClaimSettlement(claimedGeneration, candidate) &&
        canReuseOAuthCredentialAfterRefreshFailure({
          forceRefresh: params.forceRefresh,
          attempted: claimedGeneration,
          candidate,
        });
      const refreshed = refreshedStore.profiles[params.profileId];
      if (recoveryStoreLoaded && !recoveryBuildFailed && canRecover(refreshed)) {
        const recovered = await buildRecoveryAccess(refreshed);
        if (recovered) {
          return recovered;
        }
      }
      if (recoveryStoreLoaded && params.agentDir && !personalProfile && !recoveryBuildFailed) {
        try {
          const mainStore = await ensureAuthProfileStoreWithoutExternalProfilesAsync(undefined, {
            allowKeychainPrompt: false,
          });
          const mainCred = mainStore.profiles[params.profileId];
          if (canRecover(mainCred)) {
            params.validateCredential?.(mainCred);
            refreshedStore.profiles[params.profileId] = { ...mainCred };
            authProfilesLog.info("inherited fresh OAuth credentials from main agent", {
              profileId: params.profileId,
              agentDir: params.agentDir,
              expires: new Date(mainCred.expires).toISOString(),
            });
            const recovered = await buildRecoveryAccess(mainCred);
            if (recovered) {
              return recovered;
            }
          }
        } catch (cleanupError) {
          refreshError = appendOAuthRefreshCleanupErrors(refreshError, [cleanupError]);
        }
      }
      throw new OAuthManagerRefreshError({
        credential,
        attemptedCredentials: [effectiveCredential, ...attemptedCredentials],
        profileId: params.profileId,
        refreshedStore,
        retryable:
          (refreshed?.type === "oauth" && isPendingOAuthRefreshFence(refreshed)) ||
          (isTransientOAuthRefreshFailure(refreshError) &&
            refreshed?.type === "oauth" &&
            !isOAuthRefreshFence(refreshed)),
        cause: refreshError,
      });
    }
  }

  return {
    resolveOAuthAccess,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
