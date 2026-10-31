import { isDeepStrictEqual } from "node:util";
import { MessageChannel } from "node:worker_threads";
import { sqlPublicationAnchor, type EngineConnection } from "../../infra/sql-connection.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { authProfileCredentialPublication } from "../../state/user-model-account-authority.js";
import {
  prepareAuthProfileAuthorizationWrite,
  readAuthProfileAuthorizationLifetimes,
  restoreAuthProfileAuthorizationWriteIntents,
  type AuthProfileAuthorizationLifetimes,
  type AuthProfileAuthorizationWriteIntents,
} from "./authorization-lifetime.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { isSameOAuthRefreshGeneration } from "./oauth-refresh-marker.js";
import type { RuntimeExternalOAuthProfile } from "./oauth-shared.js";
import {
  loadPersistedAuthProfileStoreAtDatabasePath,
  mergePersistedAuthProfileState,
} from "./persisted.js";
import {
  createEmptyAuthProfileStore,
  markRuntimePersistedProfiles,
} from "./runtime-snapshot-owner.js";
import { writeAuthProfileJsonCell, deleteAuthProfileJsonCell } from "./sqlite-json-write.js";
import { readAuthProfileJsonCellText } from "./sqlite-json.js";
import { coerceAuthProfileState } from "./state.js";
import { prepareAuthProfileStoreMutation } from "./store-mutation.js";
import {
  buildLocalAuthProfileStoreForSave,
  type SaveAuthProfileStoreOptions,
} from "./store-save.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import {
  sendAuthProfileUpdateValue,
  receiveAuthProfileUpdateValue,
} from "./store-update-transfer.js";
import type { AuthStoreUpdateInput, AuthStoreUpdatePublication } from "./store.worker-contract.js";
import type { AuthProfileStore } from "./types.js";

export type AuthStoreUpdatePrepared = {
  store: AuthProfileStore;
  mainStore: AuthProfileStore | null;
  storePresent: boolean;
};
export type AuthStoreUpdateCommitted = {
  store: AuthProfileStore;
  authorizationLifetimes: AuthProfileAuthorizationLifetimes;
  publication: AuthStoreUpdatePublication;
  /** JSON-safe owner metadata; native settlement carries the credential receipt. */
  credentialOwner?: { identity: string; canonicalPath?: string };
  compensation?: AuthStoreCompensation;
};
type AuthStoreCompensation = {
  before: { store: unknown; state: unknown };
  after: { store: unknown; state: unknown };
};
export type AuthStoreUpdateResponse =
  | { save: false }
  | { save: true; restore: AuthStoreCompensation }
  | {
      save: true;
      store: AuthProfileStore;
      /** Compensation may restore an originally absent credential row. */
      deleteEmptyStore?: boolean;
      captureCompensation?: boolean;
      scopedSharedStore?: AuthProfileStore;
      externalProfiles: RuntimeExternalOAuthProfile[];
      runtimeStore?: AuthProfileStore;
      options?: Omit<
        SaveAuthProfileStoreOptions,
        "preserveOrderProfileIds" | "preserveStateProfileIds" | "pruneOrderProfileIds"
      > & {
        preserveOrderProfileIds?: string[];
        preserveStateProfileIds?: string[];
        pruneOrderProfileIds?: string[];
      };
    };

export type AuthStoreUpdateResponseWire =
  | { save: false }
  | (Extract<AuthStoreUpdateResponse, { save: true }> & {
      authorizationIntents: AuthProfileAuthorizationWriteIntents;
    });

/** A definite mismatch needs no write lock; possible matches reread inside the transaction. */
export function authProfilePeerGenerationMayMatch(
  database: EngineConnection,
  input: AuthStoreUpdateInput,
): boolean {
  const peer = input.peerGeneration;
  if (!peer) {
    return true;
  }
  const text = readAuthProfileJsonCellText(database, "store", "agent");
  if (text === undefined) {
    return false;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AuthProfileStoreUnreadableError(input.owner.databasePath);
  }
  const store = mergePersistedAuthProfileState(raw, () => null);
  if (!store) {
    throw new AuthProfileStoreUnreadableError(input.owner.databasePath);
  }
  const credential = store.profiles[peer.profileId];
  return (
    credential?.type === "oauth" &&
    isSameOAuthRefreshGeneration({
      profileId: peer.profileId,
      left: credential,
      right: peer.generation,
    })
  );
}

/** Run under the owning transaction: callbacks see its current rows exactly once. */
export function updateAuthProfileStoreInDatabase(
  database: EngineConnection,
  kind: "agent" | "shared-state",
  input: AuthStoreUpdateInput,
): void {
  const read = (target: "store" | "state"): unknown => {
    const text = readAuthProfileJsonCellText(database, target, kind);
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      if (target === "state") {
        return null;
      }
      throw new AuthProfileStoreUnreadableError(input.owner.databasePath);
    }
  };
  const isMainStore = input.owner.databasePath === input.owner.sharedDatabasePath;
  const prepareStores = () => {
    const existingRaw = read("store");
    const existingState = read("state") ?? null;
    const loaded = mergePersistedAuthProfileState(existingRaw, () => existingState);
    if (existingRaw !== undefined && !loaded) {
      throw new AuthProfileStoreUnreadableError(input.owner.databasePath);
    }
    const localStore = loaded ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
      ...coerceAuthProfileState(existingState),
    };
    const mainStore = isMainStore
      ? localStore
      : loadPersistedAuthProfileStoreAtDatabasePath(
          input.owner.sharedDatabasePath,
          input.owner.location === "state-db" ? "shared-state" : "agent",
        );
    return { existingRaw, existingState, loaded, localStore, mainStore };
  };
  // Env-only callbacks receive no stored facts. An explicit save still uses canonical rows.
  const prepared = input.envOnly ? undefined : prepareStores();
  const { port1, port2 } = new MessageChannel();
  try {
    sendAuthProfileUpdateValue(port1, {
      store: prepared
        ? markRuntimePersistedProfiles(prepared.localStore)
        : createEmptyAuthProfileStore(),
      mainStore: prepared && !isMainStore ? prepared.mainStore : null,
      storePresent: prepared?.existingRaw !== undefined,
    });
    requestSqliteWorkerOperationAdmission(
      {
        stage: kind === "shared-state" ? "transaction" : "prepare",
        facts: { kind: "auth-store-update", port: port2 },
      },
      [port2],
    );
    // SAFETY: The host queues one complete typed response before granting this private exchange.
    const response = receiveAuthProfileUpdateValue(port1) as AuthStoreUpdateResponseWire;
    if (!response || typeof response.save !== "boolean") {
      throw new Error("Auth profile updater produced no response");
    }
    if (!response.save) {
      return;
    }
    if ("store" in response) {
      restoreAuthProfileAuthorizationWriteIntents(
        response.store.profiles,
        response.authorizationIntents,
      );
    }
    const { existingRaw, existingState, localStore, mainStore } = prepared ?? prepareStores();
    const restoring = "restore" in response ? response.restore : undefined;
    // Each cell is restored only while this removal still owns its exact postimage.
    const restoredRaw = restoring
      ? isDeepStrictEqual(existingRaw ?? null, restoring.after.store)
        ? restoring.before.store
        : (existingRaw ?? null)
      : undefined;
    const restoredState = restoring
      ? isDeepStrictEqual(existingState, restoring.after.state)
        ? restoring.before.state
        : existingState
      : undefined;
    const next =
      "restore" in response
        ? (mergePersistedAuthProfileState(restoredRaw, () => restoredState) ?? {
            ...createEmptyAuthProfileStore(),
            ...coerceAuthProfileState(restoredState),
          })
        : buildLocalAuthProfileStoreForSave({
            owner: input.owner,
            store: response.store,
            agentDir: input.agentDir,
            options: response.options,
            persistedStores: { isMainStore, localStore, mainStore },
            getScopedSharedAuthStore: () => response.scopedSharedStore,
            listRuntimeExternalAuthProfiles: () => response.externalProfiles,
            runtimeStore: response.runtimeStore,
          });
    const mutation = prepareAuthProfileStoreMutation({
      existingRaw: existingRaw ?? null,
      existingState,
      store: next,
      selectionProfiles: {
        ...mainStore?.profiles,
        ...("store" in response ? response.store.profiles : undefined),
        ...next.profiles,
      },
    });
    // Compensation restores credential bytes, not a previously revoked authorization.
    const payload = restoring
      ? restoredRaw === null &&
        Object.keys(readAuthProfileAuthorizationLifetimes(existingRaw)).length === 0
        ? null
        : prepareAuthProfileAuthorizationWrite(
            existingRaw,
            restoredRaw ?? { version: AUTH_STORE_VERSION, profiles: {} },
          )
      : "deleteEmptyStore" in response &&
          response.deleteEmptyStore &&
          Object.keys(mutation.payload.profiles).length === 0 &&
          Object.keys(readAuthProfileAuthorizationLifetimes(mutation.payload)).length === 0
        ? null
        : mutation.payload;
    const statePayload = restoring ? restoredState : mutation.statePayload;
    const publication = {
      ...mutation.publication,
      credentialsChanged: !isDeepStrictEqual(existingRaw ?? null, payload),
      stateChanged: !isDeepStrictEqual(existingState, statePayload),
      ...(restoring
        ? {
            selectionChanged: !isDeepStrictEqual(existingState, statePayload),
            availabilityOnly: false,
          }
        : {}),
    };
    let credentialOwner: AuthStoreUpdateCommitted["credentialOwner"];
    if (publication.credentialsChanged) {
      const { receipt } = authProfileCredentialPublication.capture(
        sqlPublicationAnchor(database),
        () => {
          if (payload === null) {
            deleteAuthProfileJsonCell(database, "store", kind);
          } else {
            writeAuthProfileJsonCell(database, "store", kind, payload);
          }
        },
      );
      const credentialFacts = authProfileCredentialPublication.bound(receipt);
      const identity =
        "source" in credentialFacts ? credentialFacts.source.identity : credentialFacts.identity;
      if (typeof identity !== "string") {
        throw new Error("Auth profile credential publication has no admitted owner");
      }
      credentialOwner = { identity, canonicalPath: credentialFacts.canonicalPath };
      deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(database), {
        authCredentials: credentialFacts,
      });
    }
    if (publication.stateChanged) {
      if (statePayload) {
        writeAuthProfileJsonCell(database, "state", kind, statePayload);
      } else {
        deleteAuthProfileJsonCell(database, "state", kind);
      }
    }
    sendAuthProfileUpdateValue(port1, {
      store: markRuntimePersistedProfiles(next),
      authorizationLifetimes: readAuthProfileAuthorizationLifetimes(payload),
      publication,
      credentialOwner,
      ...("captureCompensation" in response && response.captureCompensation
        ? {
            compensation: {
              before: { store: existingRaw ?? null, state: existingState },
              after: { store: payload, state: statePayload },
            },
          }
        : {}),
    } satisfies AuthStoreUpdateCommitted);
  } finally {
    port1.close();
    port2.close();
  }
}
