import path from "node:path";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { crabboxState } from "./src/crabbox-state.test-support.js";
import { crabboxLegacyWarmImageCaptureSelector } from "./src/crabbox-worker-warm-image-records.js";
import {
  listCrabboxLegacyWarmLeases,
  openCrabboxWarmImageStore,
} from "./src/crabbox-worker-warm-image-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const migration = stateMigrations[0]!;
const image = {
  checkpointId: "chk_retained",
  kind: "machine0-image",
  state: "available",
  createdAtMs: 10,
  lastUsedAtMs: 20,
};
const migratedImage = {
  checkpointId: image.checkpointId,
  kind: image.kind,
  state: image.state,
  createdAtMs: image.createdAtMs,
  lastDemandAtMs: null,
  preparationKey: null,
  cacheKey: null,
  purpose: null,
};
let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  stateDir = tempDirs.make("openclaw-crabbox-migration-");
  env = { OPENCLAW_STATE_DIR: stateDir };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function openStore<T>(options: OpenKeyedStoreOptions) {
  return createPluginStateKeyedStoreV2ForTests<T>(
    "crabbox",
    { ...options, env },
    { assertCurrent() {} },
  );
}

function legacyImages() {
  return openStore<unknown>({
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });
}

function input(
  context: PluginDoctorStateMigrationContext = { openPluginStateKeyedStore: openStore },
) {
  return { config: {}, env, stateDir, oauthDir: path.join(stateDir, "credentials"), context };
}

async function migrateAndReopen() {
  const result = await migration.migrateLegacyState(input());
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  return result;
}

const lookup = (key = "profile") => openCrabboxWarmImageStore(crabboxState, env).lookup(key);
const migrate = () => migration.migrateLegacyState(input());
const detect = () => migration.detectLegacyState(input());

describe("Crabbox warm-profile Doctor migration", () => {
  it("preserves in-flight capture across SQLite reopen without fabricating an allocation", async () => {
    const operation = {
      type: "capture",
      id: "capture-owned",
      startedAtMs: 30,
      leaseId: "cbx_owned",
      provider: "machine0",
      phase: "creating",
    };
    const record = { ...image, operation };
    await legacyImages().register("profile", record);
    await expect(lookup()).rejects.toThrow("doctor --fix");
    const before = await legacyImages().lookup("profile");
    expect(await detect()).not.toBeNull();
    expect(await legacyImages().lookup("profile")).toEqual(before);

    const result = await migrateAndReopen();
    expect(result.warnings).toEqual([]);
    expect(await lookup()).toEqual({
      version: 3,
      image: migratedImage,
      allocations: {},
      operation,
    });
    expect(await detect()).toBeNull();
    expect(await migrate()).toEqual({ changes: [], warnings: [] });
  });

  it.each(["capture", "retire"] as const)(
    "migrates v2 with %s custody without changing allocation or runtime identities",
    async (operationType) => {
      const runtimeIdentity = {
        nodeBootstrapSha256: "a".repeat(64),
        workerBundleSha256: "b".repeat(64),
        executionMode: "worker-turn",
      };
      const allocation = {
        choice: { kind: "checkpoint", checkpointId: image.checkpointId },
        machineClass: "standard",
        os: "linux",
        phase: "prepared",
        baseCommit: "c".repeat(40),
        runtimeIdentity,
      };
      const operation =
        operationType === "capture"
          ? {
              type: "capture",
              id: "capture-v2",
              leaseId: "cbx_v2",
              provider: "aws",
              startedAtMs: 30,
              phase: "uncertain",
            }
          : { type: "retire", checkpointId: "chk_old" };
      const record = {
        version: 2,
        projectKey: "project-v2",
        image: { ...image, runtimeIdentity },
        allocations: { cbx_v2: allocation },
        operation,
      };
      await legacyImages().register("profile", record);

      expect((await migrateAndReopen()).warnings).toEqual([]);
      expect(await lookup()).toEqual({
        version: 3,
        projectKey: "project-v2",
        image: { ...migratedImage, runtimeIdentity },
        allocations: {
          cbx_v2: {
            ...allocation,
            preparationKey: null,
            cacheKey: null,
            purpose: null,
            demandAtMs: null,
            imageGeneration: null,
          },
        },
        operation,
      });
      expect(await migrate()).toEqual({ changes: [], warnings: [] });
    },
  );

  it("preserves the recovery selector of an ownerless legacy capture", async () => {
    const reserved = { ...image, checkpointId: "", kind: "", state: "pending" };
    await legacyImages().register("reserved", reserved);
    const selector = crabboxLegacyWarmImageCaptureSelector("reserved", reserved);

    await migrateAndReopen();

    expect(await lookup("reserved")).toEqual({
      version: 3,
      allocations: {},
      operation: {
        type: "capture",
        id: selector,
        startedAtMs: image.createdAtMs,
        phase: "uncertain",
      },
    });
  });

  it("reports every unresolved legacy lease with executable acknowledged recovery and keeps its row", async () => {
    const store = openStore<{ machineClass: string }>({
      namespace: "warm-leases",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
    });
    await store.register("cbx_legacy", { machineClass: "tiny" });
    const [lease] = await listCrabboxLegacyWarmLeases(crabboxState, env);
    const command = `openclaw crabbox warm-images --recover ${lease!.selector} --acknowledge-provider-cleanup`;

    expect((await detect())?.preview.join("\n")).toContain(command);
    const result = await migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("1 legacy Crabbox lease row(s)");
    expect(result.warnings.join("\n")).toContain(command);
    expect(result.warnings.join("\n")).toContain("stop the original Gateway/capture processes");
    expect(await store.lookup("cbx_legacy")).toEqual({ machineClass: "tiny" });
  });

  it("leaves unsupported records and future versions untouched", async () => {
    const rows = [
      { ...image, operation: { type: "capture", checkpointId: "unknown-paid-artifact" } },
      { ...image, unrecognizedCleanupObligation: "preserve" },
      { version: 4, allocations: {} },
    ];
    const store = legacyImages();
    for (const [index, row] of rows.entries()) {
      await store.register(String(index), row);
    }

    const result = await migrate();

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(rows.length);
    expect(
      Object.fromEntries((await store.entries()).map(({ key, value }) => [key, value])),
    ).toEqual(Object.fromEntries(rows.map((row, index) => [String(index), row])));
  });

  it.each(["changed", "write-failed", "metadata-conflict"])(
    "preserves paid ownership when publication is %s",
    async (failure) => {
      const store = legacyImages();
      await store.register("profile", image);
      const newer = { ...image, operation: { type: "retire", checkpointId: "chk_new_obligation" } };
      const compareAndApply = store.compareAndApply.bind(store);
      const publication = vi
        .spyOn(store, "compareAndApply")
        .mockImplementationOnce(async (...args) => {
          if (failure === "write-failed") {
            throw new Error("write unavailable");
          }
          await store.register(args[0], failure === "changed" ? newer : image, { ttlMs: 60_000 });
          return compareAndApply(...args);
        });
      const context: PluginDoctorStateMigrationContext = { openPluginStateKeyedStore: openStore };
      vi.spyOn(context, "openPluginStateKeyedStore").mockImplementation((options) =>
        options.namespace === "warm-images" ? store : openStore(options),
      );

      const result = await migration.migrateLegacyState(input(context));

      if (failure === "metadata-conflict") {
        expect(result.changes).toHaveLength(1);
        expect(result.warnings).toEqual([]);
        expect(await store.lookup("profile")).toMatchObject({
          version: 3,
          image: { checkpointId: image.checkpointId },
        });
        expect(publication).toHaveBeenCalledTimes(2);
      } else {
        expect(result.changes).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(await store.lookup("profile")).toEqual(failure === "changed" ? newer : image);
        expect(publication).toHaveBeenCalledOnce();
      }
    },
  );
});
