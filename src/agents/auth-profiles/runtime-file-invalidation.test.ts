import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  registerRuntimeAuthProfileExternalRefresh,
  runtimeAuthProfileRowsCache,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
} from "./runtime-snapshots.js";
import type { AuthProfileStore } from "./types.js";

const observation = vi.hoisted(() => ({
  listeners: new Set<
    (change: {
      directory: string;
      identityChanged: boolean;
      sourcesChanged: boolean;
      contentsChanged: boolean;
      createdPaths: readonly string[];
    }) => void | Promise<void>
  >(),
}));

// mock-isolation: Supply file events without native watches to prove snapshot retirement and refresh settlement.
vi.mock("./file-state.js", () => ({
  closeAuthProfileFileState() {},
  noteAuthProfileFileWrite() {},
  refreshAuthProfileFileState: async () => {},
  authProfileSourceExists: () => false,
  readAuthProfileDatabaseIdentity: vi.fn(),
  captureAuthProfileFileIdentity: vi.fn(),
  registerAuthProfileFileChangeListener: (
    listener: (change: {
      directory: string;
      identityChanged: boolean;
      sourcesChanged: boolean;
      contentsChanged: boolean;
      createdPaths: readonly string[];
    }) => void | Promise<void>,
  ) => {
    observation.listeners.add(listener);
    return () => observation.listeners.delete(listener);
  },
}));

const sharedDatabase = "/tmp/auth-file-invalidation/shared/openclaw-agent.sqlite";
const agentDatabase = "/tmp/auth-file-invalidation/agent/openclaw-agent.sqlite";

function publishAgent(key: string): void {
  const store: AuthProfileStore = {
    version: 1,
    profiles: { example: { type: "api_key", provider: "example", key } },
  };
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    store,
    agentDatabase,
    path.dirname(agentDatabase),
    { databasePath: agentDatabase, sharedDatabasePath: sharedDatabase, location: "legacy-main" },
  );
}

function observeSharedReplacement(): void {
  for (const listener of observation.listeners) {
    void listener({
      directory: path.dirname(sharedDatabase),
      identityChanged: true,
      sourcesChanged: false,
      contentsChanged: true,
      createdPaths: [],
    });
  }
}

function observeSharedRowChange(): Promise<void[]> {
  runtimeAuthProfileRowsCache.recordSource(
    sharedDatabase,
    "fixture",
    { version: 1, profiles: {} },
    async () => ({
      store: {
        status: "readable",
        raw: {
          version: 1,
          profiles: { example: { type: "api_key", provider: "example", key: "foreign" } },
        },
      },
      state: { status: "missing", reason: "row" },
      cacheable: false,
    }),
  );
  return Promise.all(
    [...observation.listeners].map((listener) =>
      Promise.resolve(
        listener({
          directory: path.dirname(sharedDatabase),
          identityChanged: false,
          sourcesChanged: false,
          contentsChanged: true,
          createdPaths: [],
        }),
      ),
    ),
  );
}

beforeEach(() => clearRuntimeAuthProfileStoreSnapshots());
afterEach(() => clearRuntimeAuthProfileStoreSnapshots());

it("retires an inherited snapshot when its shared database changes without a shared snapshot", async () => {
  const refreshed = Promise.withResolvers<boolean>();
  registerRuntimeAuthProfileExternalRefresh(() => refreshed.promise);
  publishAgent("inherited");
  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(sharedDatabase)).toBeUndefined();
  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)).toBeDefined();

  observeSharedReplacement();

  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)).toBeUndefined();
  refreshed.resolve(true);
  await refreshed.promise;
});

it.each([
  { outcome: "declined", reset: true },
  { outcome: "failed", reset: true },
  { outcome: "declined", reset: false },
  { outcome: "failed", reset: false },
] as const)(
  "keeps newer snapshots when external refresh $outcome (reset: $reset)",
  async ({ outcome, reset }) => {
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<boolean>();
    registerRuntimeAuthProfileExternalRefresh(() => {
      started.resolve();
      return refreshed.promise;
    });
    publishAgent("before");
    observeSharedReplacement();
    await started.promise;

    if (reset) {
      clearRuntimeAuthProfileStoreSnapshots();
    }
    publishAgent("replacement");
    if (outcome === "declined") {
      refreshed.resolve(false);
    } else {
      refreshed.reject(new Error("Previous lifecycle refresh failed"));
    }
    await refreshed.promise.catch(() => undefined);

    expect(
      getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)?.profiles.example,
    ).toEqual({
      type: "api_key",
      provider: "example",
      key: "replacement",
    });
  },
);

it.each(["declined", "failed"] as const)(
  "preserves newer inherited snapshots when shared refresh is %s",
  async (outcome) => {
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<boolean>();
    registerRuntimeAuthProfileExternalRefresh(() => {
      started.resolve();
      return refreshed.promise;
    });
    publishAgent("before");
    setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
      { version: 1, profiles: {} },
      sharedDatabase,
      undefined,
      { databasePath: sharedDatabase, sharedDatabasePath: sharedDatabase, location: "legacy-main" },
    );
    const observing = observeSharedRowChange();
    await started.promise;
    publishAgent("replacement");
    if (outcome === "declined") {
      refreshed.resolve(false);
    } else {
      refreshed.reject(new Error("Previous shared refresh failed"));
    }
    await refreshed.promise.catch(() => undefined);
    await observing;

    expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(sharedDatabase)).toBeUndefined();
    expect(
      getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)?.profiles.example,
    ).toMatchObject({ key: "replacement" });
  },
);

it("invalidates changed shared credentials despite an unrelated snapshot publication", async () => {
  const started = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<boolean>();
  registerRuntimeAuthProfileExternalRefresh(() => {
    started.resolve();
    return refreshed.promise;
  });
  publishAgent("before");
  const observing = observeSharedRowChange();
  await started.promise;
  const unrelated = "/tmp/auth-file-invalidation/unrelated/openclaw-agent.sqlite";
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    { version: 1, profiles: {} },
    unrelated,
    path.dirname(unrelated),
    { databasePath: unrelated, sharedDatabasePath: unrelated, location: "legacy-main" },
  );
  refreshed.resolve(false);
  await refreshed.promise;
  await observing;

  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)).toBeUndefined();
  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(unrelated)).toBeDefined();
});

it.each([false, true])(
  "checks first-file contents only with known source provenance: %s",
  async (knownSource) => {
    registerRuntimeAuthProfileExternalRefresh(async () => true);
    publishAgent("inherited");
    if (knownSource) {
      runtimeAuthProfileRowsCache.recordSource(sharedDatabase, "absent", null, async () => ({
        store: { status: "missing", reason: "table" },
        state: { status: "missing", reason: "table" },
        cacheable: false,
      }));
    }
    await Promise.all(
      [...observation.listeners].map((listener) =>
        Promise.resolve(
          listener({
            directory: path.dirname(sharedDatabase),
            identityChanged: false,
            sourcesChanged: false,
            contentsChanged: true,
            createdPaths: [sharedDatabase],
          }),
        ),
      ),
    );
    expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase) !== undefined).toBe(
      knownSource,
    );
  },
);
