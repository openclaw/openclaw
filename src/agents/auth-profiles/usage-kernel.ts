import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { AUTH_STORE_VERSION } from "./constants.js";
import { mergeAuthProfileStores, mergePersistedAuthProfileState } from "./persisted.js";
import { pruneAuthProfileStoreReferences } from "./runtime-snapshot-owner.js";
import { readAuthProfileJsonCellText, writeAuthProfileJsonCell } from "./sqlite-json.js";
import { prepareAuthProfileStateMutation } from "./store-mutation.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import {
  createAuthProfileUsageReceipt,
  type AuthProfileUsageInput,
  type AuthProfileUsageReceipt,
} from "./store.worker-contract.js";
import { reduceAuthProfileFailure } from "./usage-reduction.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

/** Reduce the authoritative health row without rewriting credential bytes. */
export function recordAuthProfileUsageInDatabase(
  database: DatabaseSync,
  databasePath: string,
  databaseKind: "agent" | "shared-state",
  input: AuthProfileUsageInput,
): AuthProfileUsageReceipt {
  const parseCell = (text: string | undefined): unknown => {
    try {
      return text === undefined ? null : (JSON.parse(text) as unknown);
    } catch {
      throw new AuthProfileStoreUnreadableError(databasePath);
    }
  };
  const credentialText = readAuthProfileJsonCellText(database, "store", databaseKind);
  const credentials = parseCell(credentialText);
  const existingState = parseCell(readAuthProfileJsonCellText(database, "state", databaseKind));
  const loaded = mergePersistedAuthProfileState(credentials, () => existingState);
  if (!loaded && credentialText !== undefined) {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  const local = loaded ?? { version: AUTH_STORE_VERSION, profiles: {} };
  const store = input.scopedSharedStore
    ? mergeAuthProfileStores(input.scopedSharedStore, local)
    : local;
  const receipt = createAuthProfileUsageReceipt(store);
  const profile = store.profiles[input.profileId];
  if (!profile) {
    return receipt;
  }
  if (!isDeepStrictEqual(credentials, input.expectedCredentials)) {
    throw new Error("Auth credentials changed during usage preparation");
  }
  const previous = store.usageStats?.[input.profileId];
  const now = Date.now();
  const canonicalProvider = (provider: string) => {
    const normalized = normalizeProviderId(provider);
    return input.providerAliases?.[normalized] ?? normalized;
  };
  const { reduction } = input;
  const next =
    reduction.kind === "success"
      ? profile &&
        !profile.setup?.replacement &&
        canonicalProvider(profile.provider) === input.providerKey
        ? resetAuthProfileFailureState(previous ?? {}, {
            lastProbeAt: now,
            ...(input.inherited ? {} : { lastUsed: reduction.lastUsed }),
          })
        : undefined
      : reduceAuthProfileFailure(profile, previous, reduction, now);
  if (!next) {
    return receipt;
  }
  if (reduction.kind === "success" && !input.inherited && input.providerKey !== undefined) {
    store.lastGood = {
      ...Object.fromEntries(
        Object.entries(store.lastGood ?? {}).filter(
          ([provider]) => canonicalProvider(provider) !== input.providerKey,
        ),
      ),
      [input.providerKey]: input.profileId,
    };
  }
  store.usageStats = { ...store.usageStats, [input.profileId]: next };
  const persisted = { ...store, profiles: local.profiles };
  if (input.scopedSharedStore) {
    const localIds = new Set(Object.keys(local.profiles));
    const orderIds = new Set([...localIds, ...Object.values(local.order ?? {}).flat()]);
    pruneAuthProfileStoreReferences(persisted, localIds, orderIds);
  }
  const { statePayload, stateChanged, selectionChanged } = prepareAuthProfileStateMutation({
    existingState,
    store: persisted,
    selectionProfiles: local.profiles,
  });
  if (stateChanged) {
    writeAuthProfileJsonCell(database, "state", databaseKind, statePayload);
  }
  receipt.result = { previous, next, now };
  receipt.publication.stateChanged = stateChanged;
  receipt.publication.selectionChanged = selectionChanged;
  return receipt;
}
