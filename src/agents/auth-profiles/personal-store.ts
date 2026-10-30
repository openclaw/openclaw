import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  capturePersonalCredentialAuthority,
  withPersonalCredentialPublication,
} from "../../state/user-model-account-authority.js";
import { parseUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import {
  normalizeUserModelAuthProfile,
  registerUserModelAuthProfileSecrets,
} from "../../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../../state/user-profile-events.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { assertPersonalAuthProfileRuntime } from "./runtime-scope.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
  UserModelAuthProfile,
} from "./types.js";

export type PersonalAuthProfileStore = {
  databasePath: string;
  read(): Promise<AuthProfileStore>;
  readCurrentCredential(this: void): AuthProfileCredential | undefined;
  /** A retry may not revive a grant whose account selection changed during provider work. */
  captureRefreshAuthority(): Promise<() => void>;
  update(
    updater: (store: AuthProfileStore) => boolean,
    assertCurrent?: () => void,
  ): Promise<AuthProfileStore>;
  accept(
    credential: OAuthCredential,
    assertCurrent?: (credential: OAuthCredential) => void,
  ): Promise<OAuthCredential>;
};

/** Retain the original actor through provider preparation, acceptance, and detached settlement. */
export function withPersonalAuthProfileStore<T>(
  profileId: string,
  consume: (owner: PersonalAuthProfileStore) => Promise<T>,
  stateDir?: string,
): Promise<T | undefined> {
  assertPersonalAuthProfileRuntime();
  const context = captureOpenClawStateWorkerContext(
    stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {},
  );
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Personal model account preparation is closed");
    }
    context.admission.assertCurrent();
    assertPersonalAuthProfileRuntime();
  };
  const result = createDeferredCore<T | undefined>();
  const retaining = trackAsyncWork(() =>
    runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const work = new AsyncWorkScope();
        const asStore = (profile: UserModelAuthProfile | undefined): AuthProfileStore => {
          if (profile) {
            registerUserModelAuthProfileSecrets(profile.credential);
          }
          return {
            version: AUTH_STORE_VERSION,
            profiles: profile ? { [profileId]: profile.credential } : {},
            ...(profile?.usageStats ? { usageStats: { [profileId]: profile.usageStats } } : {}),
          };
        };
        const readProfile = async () => {
          const authority = await capturePersonalCredentialAuthority(context, profileId);
          const profile = await scope.execute({
            type: "authProfiles.personal",
            input: { profileId, artifactPreserving: false },
          });
          assertCurrent();
          authority.observe(profile?.credential);
          // Recovery can prepare a replacement without reviving previously retained readers.
          owner.readCurrentCredential = authority.readCurrentCredential;
          return profile;
        };
        const owner: PersonalAuthProfileStore = {
          databasePath: context.admission.databasePath,
          readCurrentCredential() {
            throw new Error("Personal model account credential has not been prepared");
          },
          read: async () => asStore(await readProfile()),
          async captureRefreshAuthority() {
            const locator = parseUserModelAuthProfileId(profileId);
            if (!locator) {
              throw new Error("Personal refresh requires an exact account ID");
            }
            // Account IDs keep their original locator after a canonical profile merge.
            const locatorCurrent = captureUserProfileModelAccountLinksAuthority(
              context.admission,
              locator.ownerProfileId,
            );
            const catalog = await prepareUserProfileCatalog({
              path: context.admission.databasePath,
              env: context.environment,
            });
            try {
              const canonical = catalog.readCurrentIdentity(locator.ownerProfileId);
              if (!canonical) {
                throw new Error("Personal refresh requires a current account owner");
              }
              const canonicalCurrent =
                canonical.profileId === locator.ownerProfileId
                  ? locatorCurrent
                  : captureUserProfileModelAccountLinksAuthority(
                      context.admission,
                      canonical.profileId,
                    );
              const assertRefreshCurrent = () => {
                if (!locatorCurrent() || !canonicalCurrent()) {
                  throw new Error("Personal model account selection changed during refresh");
                }
              };
              assertRefreshCurrent();
              return assertRefreshCurrent;
            } finally {
              catalog.release();
            }
          },
          async update(updater, assertUpdateCurrent) {
            const expected = await readProfile();
            const store = asStore(expected ? structuredClone(expected) : undefined);
            if (!expected || !updater(store)) {
              return store;
            }
            const credential = store.profiles[profileId];
            if (!credential) {
              throw new Error(
                "Personal model accounts must be disconnected through their profile owner.",
              );
            }
            // The updater may retain its draft; reconciliation owns the dispatched postimage.
            const next = normalizeUserModelAuthProfile({
              credential,
              usageStats: store.usageStats?.[profileId],
            });
            registerUserModelAuthProfileSecrets(next.credential);
            const digest = createHash("sha256").update(stableStringify(next)).digest("hex");
            let nativeAdmission: SqliteWorkerOperationAdmission | undefined;
            const admission = createSqliteWorkerWriteAdmission(
              (request) => {
                assertCurrent();
                assertUpdateCurrent?.();
                if (request.stage === "commit" && request.facts !== digest) {
                  throw new Error(
                    "Personal credential publication does not match the prepared update",
                  );
                }
              },
              [context.admission.databasePath],
            );
            try {
              const updated = await runOpenClawStateWorkerOperation(
                context,
                (writer) =>
                  writer.execute({
                    type: "authProfiles.personalReplace",
                    input: { profileId, expected, next },
                  }),
                {
                  assertCurrent,
                  createAdmission: withPersonalCredentialPublication((operation) => {
                    const grant = admission(operation);
                    nativeAdmission = grant.admission;
                    return grant;
                  }, context),
                },
              );
              if (!updated) {
                throw new Error("Personal model account changed during its prepared update");
              }
              return asStore(updated);
            } catch (error) {
              if (
                isRecord(nativeAdmission?.committed?.facts) &&
                nativeAdmission.committed.facts.digest === digest &&
                hasSqliteWorkerOutcomeUnknown(error)
              ) {
                return asStore(next);
              }
              throw error;
            }
          },
          async accept(credential, assertSelectionCurrent) {
            const prepared = normalizeUserModelAuthProfile({ credential }).credential;
            if (prepared.type !== "oauth") {
              throw new Error("Personal credential codec changed the prepared credential type");
            }
            assertCurrent();
            assertSelectionCurrent?.(prepared);
            // Credential writers publish before settlement; acceptance needs no database turn.
            if (!isDeepStrictEqual(owner.readCurrentCredential(), prepared)) {
              throw new Error("Personal model account changed during provider preparation");
            }
            observeCanonicalAuthProfileCredentials(context.admission.databasePath, {
              [profileId]: prepared,
            });
            return prepared;
          },
        };
        try {
          result.resolve(await work.track(() => consume(owner)));
        } catch (error) {
          result.reject(error);
        } finally {
          try {
            await work.drain();
          } finally {
            active = false;
          }
        }
      },
      { existingOnly: true, assertCurrent },
    ),
  );
  void retaining.then(() => result.resolve(undefined), result.reject);
  return result.promise;
}
