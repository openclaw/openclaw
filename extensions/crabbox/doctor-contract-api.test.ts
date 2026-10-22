import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { crabboxState } from "./src/crabbox-state.test-support.js";
import { crabboxLegacyWarmImageCaptureSelector } from "./src/crabbox-worker-warm-image-records.js";
import {
  listCrabboxLegacyWarmLeases,
  openCrabboxWarmImageStore,
} from "./src/crabbox-worker-warm-image-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await reopen();
    vi.restoreAllMocks();
    cleanup();
  }),
);
const migration = stateMigrations[0]!;
const imageMetadata = {
  checkpointId: "chk_retained",
  kind: "machine0-image",
  state: "available",
  createdAtMs: 10,
};
const image = { ...imageMetadata, lastUsedAtMs: 20 };
const unknownPreparation = { preparationKey: null, cacheKey: null, purpose: null };
const migratedImage = { ...imageMetadata, ...unknownPreparation, lastDemandAtMs: null };
let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  await reopen();
  stateDir = tempDirs.make("openclaw-crabbox-migration-");
  env = { OPENCLAW_STATE_DIR: stateDir };
});

function openStore<T>(options: OpenKeyedStoreOptions) {
  return crabboxState.openKeyedStoreV2<T>({ ...options, env });
}

const legacyImages = () =>
  openStore<unknown>({
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });

function input(
  context: PluginDoctorStateMigrationContext = { openPluginStateKeyedStore: openStore },
) {
  return { config: {}, env, stateDir, oauthDir: "unused", context };
}

async function reopen() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

const lookup = (key = "profile") => openCrabboxWarmImageStore(crabboxState, env).lookup(key);
const migrate = () => migration.migrateLegacyState(input());
const detect = () => migration.detectLegacyState(input());

const capture = {
  type: "capture",
  id: "capture-owned",
  startedAtMs: 30,
  leaseId: "cbx_v2",
  provider: "machine0",
  phase: "creating",
};
const reserved = { ...image, checkpointId: "", kind: "", state: "pending" };
function v2Case(operation: object) {
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
  const record = {
    version: 2,
    projectKey: "project-v2",
    image: { ...image, runtimeIdentity },
    allocations: { cbx_v2: allocation },
    operation,
  };
  const migratedAllocation = {
    ...allocation,
    ...unknownPreparation,
    demandAtMs: null,
    imageGeneration: null,
  };
  const expected = {
    ...record,
    version: 3,
    image: { ...migratedImage, runtimeIdentity },
    allocations: { cbx_v2: migratedAllocation },
  };
  return [record, expected] as const;
}

it.each([
  [
    "legacy capture",
    { ...image, operation: capture },
    { version: 3, image: migratedImage, allocations: {}, operation: capture },
  ],
  ["v2 capture", ...v2Case({ ...capture, provider: "aws", phase: "uncertain" })],
  ["v2 retirement", ...v2Case({ type: "retire", checkpointId: "chk_old" })],
  [
    "ownerless capture",
    reserved,
    {
      version: 3,
      allocations: {},
      operation: {
        type: "capture",
        id: crabboxLegacyWarmImageCaptureSelector("profile", reserved),
        startedAtMs: image.createdAtMs,
        phase: "uncertain",
      },
    },
  ],
] as const)("durably migrates %s", async (_name, record, expected) => {
  const store = legacyImages();
  await store.register("profile", record);
  await expect(lookup()).rejects.toThrow("doctor --fix");
  expect(await detect()).not.toBeNull();
  expect(await store.lookup("profile")).toEqual(record);
  expect((await migrate()).warnings).toEqual([]);
  await reopen();
  expect(await lookup()).toEqual(expected);
  expect(await detect()).toBeNull();
  expect(await migrate()).toEqual({ changes: [], warnings: [] });
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
  const { changes, warnings } = await migrate();
  expect(changes).toEqual([]);
  expect(warnings.join("\n")).toContain("1 legacy Crabbox lease row(s)");
  expect(warnings.join("\n")).toContain(command);
  expect(warnings.join("\n")).toContain("stop the original Gateway/capture processes");
  expect(await store.lookup("cbx_legacy")).toEqual({ machineClass: "tiny" });
});

it("keeps every unsupported record and future version untouched", async () => {
  const rows = [
    { ...image, operation: { type: "capture", checkpointId: "unknown-paid-artifact" } },
    { ...image, unrecognizedCleanupObligation: "preserve" },
    { version: 4, allocations: {} },
  ];
  const store = legacyImages();
  const entries = rows.map((value, index) => [String(index), value] as const);
  for (const [key, value] of entries) {
    await store.register(key, value);
  }
  expect(await migrate()).toEqual({ changes: [], warnings: rows.map(() => expect.any(String)) });
  const remaining = (await store.entries()).map(({ key, value }) => [key, value]);
  expect(Object.fromEntries(remaining)).toEqual(Object.fromEntries(entries));
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
    const retried = failure === "metadata-conflict";
    expect([result.changes.length, result.warnings.length, publication.mock.calls.length]).toEqual(
      retried ? [1, 0, 2] : [0, 1, 1],
    );
    if (retried) {
      expect(await store.lookup("profile")).toMatchObject({
        version: 3,
        image: { checkpointId: image.checkpointId },
      });
    } else {
      expect(await store.lookup("profile")).toEqual(failure === "changed" ? newer : image);
    }
  },
);
