import { createHash } from "node:crypto";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { registerUserModelAuthProfileSecrets } from "../../state/user-model-accounts.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { assertPersonalAuthProfileRuntime } from "./runtime-scope.js";
import type { AuthProfileStore, OAuthCredential, UserModelAuthProfile } from "./types.js";

export type PersonalAuthProfileStore = {
  databasePath: string;
  read(): Promise<AuthProfileStore>;
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
          const profile = await scope.execute({
            type: "authProfiles.personal",
            input: { profileId, artifactPreserving: false },
          });
          assertCurrent();
          return profile;
        };
        const owner: PersonalAuthProfileStore = {
          databasePath: context.admission.databasePath,
          read: async () => asStore(await readProfile()),
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
            const next: UserModelAuthProfile = structuredClone({
              credential,
              usageStats: store.usageStats?.[profileId],
            });
            registerUserModelAuthProfileSecrets(next.credential);
            const digest = createHash("sha256").update(JSON.stringify(next)).digest("hex");
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
                  createAdmission: (operation) => {
                    const grant = admission(operation);
                    nativeAdmission = grant.admission;
                    return grant;
                  },
                },
              );
              if (!updated) {
                throw new Error("Personal model account changed during its prepared update");
              }
              return asStore(updated);
            } catch (error) {
              if (
                nativeAdmission?.committed?.facts === digest &&
                hasSqliteWorkerOutcomeUnknown(error)
              ) {
                return asStore(next);
              }
              throw error;
            }
          },
          async accept(credential, assertSelectionCurrent) {
            const prepared = structuredClone(credential);
            // Accept while the actor still holds the exact-row snapshot and FIFO turn.
            const accepted = await runOpenClawStateWorkerOperation(
              context,
              (reader) =>
                reader.execute({
                  type: "authProfiles.personalAccept",
                  input: { profileId, credential: prepared },
                }),
              {
                assertCurrent,
                createAdmission: createSqliteWorkerWriteAdmission(
                  (request) => {
                    assertCurrent();
                    assertSelectionCurrent?.(structuredClone(prepared));
                    if (request.stage === "commit") {
                      observeCanonicalAuthProfileCredentials(context.admission.databasePath, {
                        [profileId]: prepared,
                      });
                    }
                  },
                  [context.admission.databasePath],
                ),
              },
            );
            if (!accepted) {
              throw new Error("Personal model account changed during provider preparation");
            }
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
