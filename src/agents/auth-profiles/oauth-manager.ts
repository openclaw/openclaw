import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
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
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS, authProfilesLog } from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import {
  resolveEffectiveOAuthCredentialCore,
  type OAuthBootstrapCredentialReader,
} from "./effective-oauth.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import {
  OAuthManagerRefreshError,
  OAuthRefreshFailureError,
  appendOAuthRefreshCleanupErrors,
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
  readPendingOAuthRefreshClaimId,
  readOAuthRefreshGenerationDigest,
} from "./oauth-refresh-marker.js";
import { beginOAuthRefreshObservation } from "./oauth-refresh-observation.js";
import {
  failOAuthRefreshPeerClaims,
  fenceOAuthRefreshPeers,
  OAuthRefreshPeerFenceError,
  rollbackOAuthRefreshPeerClaims,
  settleOAuthRefreshPeerClaims,
  type OAuthRefreshPeerClaim,
} from "./oauth-refresh-peers.js";
import {
  isSafeOAuthOwnerRefreshResult,
  isSafeOAuthPostClaimSettlement,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "./oauth-shared.js";
import {
  canReuseOAuthCredentialAfterRefreshFailure,
  loadStoredOAuthRefreshStore,
  markOAuthRefreshClaimFailed,
  rollbackOAuthRefreshOwnerClaim,
  settleOAuthRefreshClaim,
  updateOAuthStore,
  type OAuthRefreshClaim,
  type ResolvedOAuthAccess,
} from "./oauth-store.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";
import { withPersonalAuthProfileStore, type PersonalAuthProfileStore } from "./personal-store.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";

type OAuthManagerAdapter = {
  buildApiKey: (
    provider: string,
    credentials: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string },
  ) => Promise<string>;
  refreshCredential: (
    credential: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string },
  ) => Promise<OAuthCredentials | null>;
  canRefreshCredential: (
    credential: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string },
  ) => Promise<boolean>;
  readBootstrapCredential: OAuthBootstrapCredentialReader;
};

const oauthRefreshRecoveryBuildFailures = new WeakSet<Error>();

/** Create an OAuth manager bound to provider-specific build/refresh adapters. */
export function createOAuthManager(adapter: OAuthManagerAdapter) {
  async function buildValidatedAccess(
    credential: OAuthCredential,
    context: {
      cfg?: OpenClawConfig;
      agentDir?: string;
      validateCredential?: (credential: OAuthCredential) => void;
      personalStore?: PersonalAuthProfileStore;
    },
  ): Promise<ResolvedOAuthAccess> {
    context.validateCredential?.(credential);
    const apiKey = await adapter.buildApiKey(
      credential.provider,
      context.personalStore ? structuredClone(credential) : credential,
      {
        cfg: context.cfg,
        agentDir: context.agentDir,
      },
    );
    const accepted = context.personalStore
      ? await context.personalStore.accept(credential, (current) =>
          context.validateCredential?.(current),
        )
      : credential;
    if (context.personalStore) {
      context.validateCredential?.(accepted);
    }
    return { apiKey, credential: accepted };
  }

  function adoptNewerMainOAuthCredential(params: {
    profileId: string;
    agentDir?: string;
    credential: OAuthCredential;
  }): OAuthCredential | null {
    if (!params.agentDir || isUserModelAuthProfileId(params.profileId)) {
      return null;
    }
    try {
      const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
        allowKeychainPrompt: false,
      });
      const mainCred = mainStore.profiles[params.profileId];
      if (mainCred?.type !== "oauth") {
        return null;
      }
      const mainExpires = asDateTimestampMs(mainCred.expires);
      const localExpires = asDateTimestampMs(params.credential.expires);
      if (
        mainCred.provider === params.credential.provider &&
        hasUsableOAuthCredential(mainCred) &&
        mainExpires !== undefined &&
        (localExpires === undefined || mainExpires > localExpires) &&
        isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
      ) {
        return mainCred;
      }
    } catch (err) {
      authProfilesLog.debug("adoptNewerMainOAuthCredential failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
    return null;
  }

  let refreshQueue = new KeyedAsyncQueue();

  class OAuthSettlementCredentialValidationError extends Error {
    constructor(cause: unknown, cleanupErrors: readonly unknown[] = []) {
      const error = toErrorObject(cause, "OAuth credential validation failed");
      super(error.message, { cause: appendOAuthRefreshCleanupErrors(error, cleanupErrors) });
      this.name = "OAuthSettlementCredentialValidationError";
    }
  }

  function validateSettlementCredential(
    validateCredential: ((credential: OAuthCredential) => void) | undefined,
    credential: OAuthCredential,
  ): void {
    try {
      validateCredential?.(credential);
    } catch (error) {
      throw new OAuthSettlementCredentialValidationError(error);
    }
  }

  async function resolveAuthoritativeSharedOAuthCredentialUnderLock(params: {
    profileId: string;
    candidate: OAuthCredential;
    validateCredential?: (credential: OAuthCredential) => void;
  }): Promise<OAuthCredential | undefined> {
    let validatedAuthoritative = false;
    const acceptAuthoritative = (credential: OAuthCredential): boolean => {
      try {
        validateSettlementCredential(params.validateCredential, credential);
        validatedAuthoritative = true;
        return true;
      } catch {
        authProfilesLog.warn(
          "refused shared OAuth credential during settlement: credential validation failed",
          {
            profileId: params.profileId,
          },
        );
        return false;
      }
    };
    const updated = await updateAuthProfileStoreWithLock({
      agentDir: undefined,
      profileId: params.profileId,
      sharedStoreWrite: true,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        const decision = shouldMirrorRefreshedOAuthCredential({
          existing,
          refreshed: params.candidate,
        });
        if (!decision.shouldMirror) {
          if (decision.reason === "identity-mismatch-or-regression") {
            authProfilesLog.warn(
              "refused to mirror OAuth credential: identity mismatch or regression",
              {
                profileId: params.profileId,
              },
            );
          }
          if (decision.reason === "incoming-not-fresher" && existing?.type === "oauth") {
            acceptAuthoritative(existing);
          }
          return false;
        }
        if (existing?.type === "oauth" && !acceptAuthoritative(existing)) {
          return false;
        }
        store.profiles[params.profileId] = { ...params.candidate };
        validatedAuthoritative = true;
        authProfilesLog.debug("mirrored refreshed OAuth credential to main agent store", {
          profileId: params.profileId,
          expires: Number.isFinite(params.candidate.expires)
            ? new Date(params.candidate.expires).toISOString()
            : undefined,
        });
        return true;
      },
    });
    if (updated === null) {
      throw new Error("Failed to read authoritative shared OAuth credential");
    }
    if (!validatedAuthoritative) {
      return undefined;
    }
    const authoritative = updated.profiles[params.profileId];
    return authoritative?.type === "oauth" ? authoritative : undefined;
  }

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
    settleOAuthRefreshPeerClaims({
      profileId: params.claim.profileId,
      fence: params.claim.fence,
      claims: params.claims,
      authoritativeSharedCredential,
      replacement: params.replacement,
    });
  }

  function mergePeerClaims(
    existing: readonly OAuthRefreshPeerClaim[],
    discovered: readonly OAuthRefreshPeerClaim[],
  ): OAuthRefreshPeerClaim[] {
    const claims = new Map(existing.map((claim) => [claim.candidate.databasePath, claim]));
    for (const claim of discovered) {
      const current = claims.get(claim.candidate.databasePath);
      claims.set(claim.candidate.databasePath, current?.original ? current : claim);
    }
    return [...claims.values()].toSorted((left, right) =>
      left.candidate.databasePath.localeCompare(right.candidate.databasePath),
    );
  }

  async function claimOAuthRefresh(params: {
    personalStore?: PersonalAuthProfileStore;
    profileId: string;
    provider: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    signal?: AbortSignal;
    forceRefresh?: boolean;
    attemptedCredential: OAuthCredential;
    bootstrapCredential?: OAuthCredential | null;
    bootstrapBaseCredential?: OAuthCredential;
    validateCredential?: (credential: OAuthCredential) => void;
  }): Promise<OAuthRefreshClaim> {
    const personalProfile = isUserModelAuthProfileId(params.profileId);
    const ownerAgentDir = personalProfile
      ? undefined
      : resolvePersistedAuthProfileOwnerAgentDir(params);
    const authPath =
      params.personalStore?.databasePath ??
      (ownerAgentDir
        ? resolveAuthProfileDatabasePath(ownerAgentDir)
        : resolveSharedAuthStorePath());
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);
    const peerConfig = params.cfg ?? {};
    const fenceTerminalPeers = (credential: OAuthCredential) =>
      fenceOAuthRefreshPeers({
        cfg: peerConfig,
        ownerDatabasePath: authPath,
        profileId: params.profileId,
        generation: credential,
        fence: credential,
      });

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
            const peerClaims = personalProfile ? [] : await fenceTerminalPeers(cred);
            failOAuthRefreshPeerClaims({
              profileId: params.profileId,
              fence: cred,
              claims: peerClaims,
            });
            return { kind: "unavailable" };
          }
          if (normalizeSecretInputString(credentialToRefresh.refresh) === undefined) {
            return { kind: "unavailable" };
          }
          if (
            !(await adapter.canRefreshCredential(
              personalProfile ? structuredClone(credentialToRefresh) : credentialToRefresh,
              {
                cfg: params.cfg,
                agentDir: params.agentDir,
              },
            ))
          ) {
            return { kind: "unavailable" };
          }

          const fence = createOAuthRefreshFence({
            profileId: params.profileId,
            credential: credentialToRefresh,
          });
          const claimId = readPendingOAuthRefreshClaimId(fence);
          if (!claimId) {
            throw new Error("OAuth refresh fence is missing its claim identity");
          }
          observation = beginOAuthRefreshObservation({
            databasePath: authPath,
            profileId: params.profileId,
            provider: params.provider,
            claimId,
            generation: readOAuthRefreshGenerationDigest({
              profileId: params.profileId,
              credential: fence,
            }),
          });
          let claimed = false;
          const updated = await updateOAuthStore({
            personalStore: params.personalStore,
            assertCurrent: () => {
              params.signal?.throwIfAborted();
              params.validateCredential?.(credentialToRefresh);
            },
            agentDir: ownerAgentDir,
            profileId: params.profileId,
            updater: (authoritative) => {
              const existing = authoritative.profiles[params.profileId];
              params.signal?.throwIfAborted();
              if (!isExactOAuthCredential(existing, cred)) {
                return false;
              }
              authoritative.profiles[params.profileId] = fence;
              claimed = true;
              return true;
            },
          });
          if (updated === null || !claimed) {
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
              const peerClaims = personalProfile ? [] : await fenceTerminalPeers(current);
              failOAuthRefreshPeerClaims({
                profileId: params.profileId,
                fence: current,
                claims: peerClaims,
              });
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
                onFence: observation.includeDatabase,
              });
            }
          } catch (error) {
            observation.beginSettlement();
            if (error instanceof OAuthRefreshPeerFenceError) {
              peerClaims = mergePeerClaims(peerClaims, error.claims);
            }
            const cleanupErrors: unknown[] = [];
            try {
              rollbackOAuthRefreshPeerClaims({
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

  async function refreshOAuthTokenWithLock(params: {
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
  }): Promise<ResolvedOAuthAccess | null> {
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
          return await buildValidatedAccess(credential, params);
        },
      });
      return observed;
    }
    if (claim.kind === "use") {
      return await buildValidatedAccess(claim.credential, params);
    }

    params.attemptedCredentials?.push(claim.credential);
    const peerConfig = params.cfg ?? {};
    let activePeerClaims = claim.peerClaims;

    const rediscoverPeerClaims = async (generation: OAuthCredential) => {
      try {
        activePeerClaims = mergePeerClaims(
          activePeerClaims,
          await fenceOAuthRefreshPeers({
            cfg: peerConfig,
            ownerDatabasePath: claim.authPath,
            profileId: params.profileId,
            generation,
            fence: claim.fence,
            rollbackOnFailure: false,
            onFence: claim.observation.includeDatabase,
          }),
        );
      } catch (error) {
        if (error instanceof OAuthRefreshPeerFenceError) {
          activePeerClaims = mergePeerClaims(activePeerClaims, error.claims);
        }
        throw error;
      }
    };

    type FailureSettlement = {
      supersedingOwner: OAuthCredential | null;
      validationError: OAuthSettlementCredentialValidationError | null;
      cleanupErrors: unknown[];
    };

    const failClaim = async (): Promise<FailureSettlement> => {
      let result: FailureSettlement = {
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
              const owner = (
                await loadStoredOAuthRefreshStore(
                  claim.ownerAgentDir,
                  params.profileId,
                  params.personalStore,
                )
              ).profiles[params.profileId];
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
            if (claim.peerGeneration) {
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
            try {
              failOAuthRefreshPeerClaims({
                profileId: params.profileId,
                fence: claim.fence,
                claims: activePeerClaims,
              });
            } catch (error) {
              cleanupErrors.push(error);
            }
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
    }): Promise<ResolvedOAuthAccess | null> => {
      claim.observation.beginSettlement();
      const initiatingError = failure
        ? toErrorObject(failure.error, "OAuth refresh failed")
        : undefined;
      const { supersedingOwner, validationError, cleanupErrors } = await failClaim();
      if (validationError) {
        throw new OAuthSettlementCredentialValidationError(validationError, cleanupErrors);
      }
      if (supersedingOwner) {
        try {
          return await buildValidatedAccess(supersedingOwner, params);
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
          });
          markOAuthRefreshFailureSettled(settled, error);
          throw settled;
        }
        throw error;
      }
      if (cleanupErrors.length === 0) {
        return null;
      }
      throw appendOAuthRefreshCleanupErrors(cleanupErrors[0], cleanupErrors.slice(1));
    };

    const settlement = trackAsyncWork(async (): Promise<ResolvedOAuthAccess | null> => {
      let refreshed: OAuthCredentials | null;
      try {
        refreshed = await adapter.refreshCredential(
          params.personalStore ? structuredClone(claim.credential) : claim.credential,
          {
            cfg: params.cfg,
            agentDir: params.agentDir,
          },
        );
      } catch (error) {
        return await settleFailure({ error, externalRefresh: true });
      }
      claim.observation.beginSettlement();
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
                try {
                  failOAuthRefreshPeerClaims({
                    profileId: params.profileId,
                    fence: claim.fence,
                    claims: activePeerClaims,
                  });
                } catch (error) {
                  cleanupErrors.push(error);
                }
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
              try {
                failOAuthRefreshPeerClaims({
                  profileId: params.profileId,
                  fence: claim.fence,
                  claims: activePeerClaims,
                });
              } catch (error) {
                authProfilesLog.warn("failed to terminally fence an OAuth refresh peer", {
                  profileId: params.profileId,
                  error: formatErrorMessage(error),
                });
              }
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
        return await buildValidatedAccess(settled.credential, params);
      } catch (error) {
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
      : ((await withPersonalAuthProfileStore(prepared.profileId, resolve)) ?? null);
  }

  async function resolveOwnedOAuthAccess(
    params: Parameters<typeof resolveOAuthAccess>[0],
  ): Promise<ResolvedOAuthAccess | null> {
    params.signal?.throwIfAborted();
    const personalProfile = isUserModelAuthProfileId(params.profileId);
    let credential = params.credential;
    if (personalProfile) {
      const owned = (
        await loadStoredOAuthRefreshStore(params.agentDir, params.profileId, params.personalStore)
      ).profiles[params.profileId];
      if (owned?.type !== "oauth") {
        return null;
      }
      credential = owned;
    }
    const newerMainCredential = adoptNewerMainOAuthCredential({
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
      : adapter.readBootstrapCredential({
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
      return await buildValidatedAccess(effectiveCredential, params);
    }

    try {
      const queued = trackAsyncWork(() =>
        refreshQueue.enqueue(`${credential.provider}\u0000${params.profileId}`, () =>
          refreshOAuthTokenWithLock({
            personalStore: params.personalStore,
            profileId: params.profileId,
            provider: credential.provider,
            agentDir: params.agentDir,
            cfg: params.cfg,
            signal: params.signal,
            forceRefresh: params.forceRefresh,
            attemptedCredential: effectiveCredential,
            attemptedCredentials,
            bootstrapCredential,
            bootstrapBaseCredential: adoptedCredential,
            validateCredential: params.validateCredential,
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
          return await buildValidatedAccess(candidate, params);
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
      const refreshed = refreshedStore.profiles[params.profileId];
      if (recoveryStoreLoaded && !recoveryBuildFailed) {
        if (
          refreshed?.type === "oauth" &&
          isSafeOAuthPostClaimSettlement(claimedGeneration, refreshed) &&
          canReuseOAuthCredentialAfterRefreshFailure({
            forceRefresh: params.forceRefresh,
            attempted: claimedGeneration,
            candidate: refreshed,
          })
        ) {
          const recovered = await buildRecoveryAccess(refreshed);
          if (recovered) {
            return recovered;
          }
        }
      }
      if (recoveryStoreLoaded && params.agentDir && !personalProfile && !recoveryBuildFailed) {
        try {
          const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
            allowKeychainPrompt: false,
          });
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            isSafeOAuthPostClaimSettlement(claimedGeneration, mainCred) &&
            canReuseOAuthCredentialAfterRefreshFailure({
              forceRefresh: params.forceRefresh,
              attempted: claimedGeneration,
              candidate: mainCred,
            })
          ) {
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
        cause: refreshError,
      });
    }
  }

  function resetRefreshQueuesForTest(): void {
    refreshQueue = new KeyedAsyncQueue();
  }

  return {
    resolveOAuthAccess,
    resetRefreshQueuesForTest,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
