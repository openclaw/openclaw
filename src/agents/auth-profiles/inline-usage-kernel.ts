import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { mergePersistedAuthProfileState } from "./persisted.js";
import { inspectAuthProfileJsonCell, writeAuthProfileJsonCell } from "./sqlite-json.js";
import { prepareAuthProfileStateMutation } from "./store-mutation.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";
import { computeNextProfileUsageStats } from "./usage-failure-state.js";
import { resolveInlineProviderApiKeyUsageId } from "./usage-state.js";

export type InlineAuthFailureInput = {
  provider: string;
  reason: Extract<AuthProfileFailureReason, "auth" | "auth_permanent" | "billing">;
  modelId?: string;
  expectedCredentials: unknown;
  inheritedUsageStats?: AuthProfileStore["usageStats"];
};

export type InlineAuthFailureReceipt = {
  store: AuthProfileStore;
  previousStats?: ProfileUsageStats;
  nextStats: ProfileUsageStats;
  now: number;
  publication: {
    credentialsChanged: boolean;
    profileSetChanged: boolean;
    stateChanged: boolean;
    selectionChanged: boolean;
    profileIds: string[];
  };
};

export type InlineAuthFailureResult =
  | { ok: true; receipt: InlineAuthFailureReceipt }
  | { ok: false; error: OpenClawStateWorkerErrorPayload };

export type InlineAuthFailureOperations = {
  "authProfiles.inlineSnapshot": {
    input: undefined;
    output: import("./types.js").AuthProfileRowRead;
  };
  "authProfiles.inlineFailure": { input: InlineAuthFailureInput; output: InlineAuthFailureResult };
};

/** The admitted agent transaction owns the fresh read, health reduction, and durable cells. */
export function recordInlineAuthFailureInDatabase(
  database: DatabaseSync,
  databasePath: string,
  input: InlineAuthFailureInput,
): InlineAuthFailureReceipt {
  const credentials = inspectAuthProfileJsonCell(database, "store", "agent");
  if (
    !isDeepStrictEqual(
      credentials.status === "readable" ? credentials.raw : null,
      input.expectedCredentials,
    )
  ) {
    throw new Error("Auth credentials changed during inline-failure preparation");
  }
  const state = inspectAuthProfileJsonCell(database, "state", "agent");
  const existingState = state.status === "readable" ? state.raw : null;
  const loaded = mergePersistedAuthProfileState(
    credentials.status === "readable" ? credentials.raw : null,
    () => existingState,
  );
  if (!loaded && credentials.status !== "missing") {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  const store = loaded ?? { version: AUTH_STORE_VERSION, profiles: {} };
  // The bounded CLI auth scope supplies its captured shared read-through facts.
  // Persist only state that the existing local-save owner retains.
  const inheritedUsageStats = Object.fromEntries(
    Object.entries(input.inheritedUsageStats ?? {}).filter(
      ([profileId]) => store.profiles[profileId] || profileId.startsWith("inline-api-key:"),
    ),
  );
  store.usageStats = { ...inheritedUsageStats, ...store.usageStats };
  const usageId = resolveInlineProviderApiKeyUsageId(input.provider);
  const previousStats = store.usageStats?.[usageId];
  const now = Date.now();
  const nextStats = computeNextProfileUsageStats({
    existing: previousStats ?? {},
    now,
    reason: input.reason,
    modelId: input.modelId,
  });
  store.usageStats = { ...store.usageStats, [usageId]: nextStats };
  const { statePayload, stateChanged, selectionChanged } = prepareAuthProfileStateMutation({
    existingState,
    store,
    selectionProfiles: store.profiles,
  });
  // A state row needs the same empty credential-store anchor as ordinary auth saves.
  // Existing credential bytes belong to credential mutations, not usage bookkeeping.
  if (credentials.status === "missing") {
    writeAuthProfileJsonCell(database, "store", "agent", {
      version: AUTH_STORE_VERSION,
      profiles: {},
    });
  }
  if (stateChanged) {
    writeAuthProfileJsonCell(database, "state", "agent", statePayload);
  }
  return {
    store,
    previousStats,
    nextStats,
    now,
    publication: {
      credentialsChanged: false,
      profileSetChanged: false,
      stateChanged,
      selectionChanged,
      profileIds: [],
    },
  };
}
