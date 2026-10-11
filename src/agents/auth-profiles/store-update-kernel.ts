import type { DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
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
import {
  readAuthProfileJsonCellText,
  writeAuthProfileJsonCell,
  deleteAuthProfileJsonCell,
} from "./sqlite-json.js";
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
};
export type AuthStoreUpdateCommitted = {
  store: AuthProfileStore;
  authorizationLifetimes: AuthProfileAuthorizationLifetimes;
  publication: AuthStoreUpdatePublication;
};
export type AuthStoreUpdateCommittedWire = {
  store: AuthProfileStore;
  authorizationLifetimes: AuthProfileAuthorizationLifetimes;
  publication: Omit<AuthStoreUpdatePublication, "oauthRefreshClaimIds"> & {
    oauthRefreshClaimIds: Array<[string, string | null]>;
  };
};
export type AuthStoreUpdateResponse =
  | { save: false }
  | {
      save: true;
      store: AuthProfileStore;
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
  database: DatabaseSync,
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
  database: DatabaseSync,
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
        ? markRuntimePersistedProfiles(prepared.loaded ?? createEmptyAuthProfileStore())
        : createEmptyAuthProfileStore(),
      mainStore: prepared && !isMainStore ? prepared.mainStore : null,
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
    restoreAuthProfileAuthorizationWriteIntents(
      response.store.profiles,
      response.authorizationIntents,
    );
    const { existingRaw, existingState, localStore, mainStore } = prepared ?? prepareStores();
    const next = buildLocalAuthProfileStoreForSave({
      owner: input.owner,
      store: response.store,
      agentDir: input.agentDir,
      options: response.options,
      persistedStores: { isMainStore, localStore, mainStore },
      getScopedSharedAuthStore: () => response.scopedSharedStore,
      listRuntimeExternalAuthProfiles: () => response.externalProfiles,
      runtimeStore: response.runtimeStore,
    });
    const { payload, statePayload, publication } = prepareAuthProfileStoreMutation({
      existingRaw: existingRaw ?? null,
      existingState,
      store: next,
      selectionProfiles: { ...mainStore?.profiles, ...response.store.profiles, ...next.profiles },
    });
    if (publication.credentialsChanged) {
      writeAuthProfileJsonCell(database, "store", kind, payload);
      deferSqliteWorkerCommitReceipt(database, "auth-profile-authorization");
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
      publication: {
        ...publication,
        oauthRefreshClaimIds: Array.from(
          publication.oauthRefreshClaimIds,
          ([profileId, claimId]): [string, string | null] => [profileId, claimId ?? null],
        ),
      },
    } satisfies AuthStoreUpdateCommittedWire);
  } finally {
    port1.close();
    port2.close();
  }
}
