import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/runtime-doctor-migrations";
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
  runtimeIdentity: {
    nodeBootstrapSha256: "a".repeat(64),
    workerBundleSha256: "b".repeat(64),
    executionMode: "worker-turn",
  },
};
const image = { ...imageMetadata, lastUsedAtMs: 20 };
const unknownPreparation = { preparationKey: null, cacheKey: null, purpose: null };
const migratedImage = { ...imageMetadata, ...unknownPreparation, lastDemandAtMs: null };
let params: Parameters<typeof migration.migrateLegacyState>[0];

beforeEach(async () => {
  await reopen();
  const stateDir = tempDirs.make("openclaw-crabbox-migration-");
  params = {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: "unused",
    context: { openPluginStateKeyedStore: openStore },
  };
});

function openStore<T>(options: OpenKeyedStoreOptions) {
  return crabboxState.openKeyedStoreV2<T>({ ...options, env: params.env });
}

const legacyImages = () =>
  openStore<unknown>({
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });

async function reopen() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

const lookup = () => openCrabboxWarmImageStore(crabboxState, params.env).lookup("profile");
const migrate = () => migration.migrateLegacyState(params);
const detect = () => migration.detectLegacyState(params);

const capture = {
  type: "capture",
  id: "capture-owned",
  startedAtMs: 30,
  leaseId: "cbx_v2",
  provider: "machine0",
  phase: "creating",
};
const reserved = { ...image, checkpointId: "", kind: "", state: "pending" };
const profile = (profileImage: unknown, operation: object, allocations = {}) => ({
  version: 3,
  image: profileImage,
  operation,
  allocations,
});
function v2Case(operation: object) {
  const allocation = {
    choice: { kind: "checkpoint", checkpointId: image.checkpointId },
    machineClass: "standard",
    os: "linux",
    phase: "prepared",
    baseCommit: "c".repeat(40),
    runtimeIdentity: image.runtimeIdentity,
  };
  return [
    { ...profile(image, operation, { cbx_v2: allocation }), version: 2, projectKey: "project-v2" },
    {
      ...profile(migratedImage, operation, {
        cbx_v2: { ...allocation, ...unknownPreparation, demandAtMs: null, imageGeneration: null },
      }),
      projectKey: "project-v2",
    },
  ] as const;
}

it.each([
  ["legacy capture", { ...image, operation: capture }, profile(migratedImage, capture)],
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
  const [lease] = await listCrabboxLegacyWarmLeases(crabboxState, params.env);
  const command = `openclaw crabbox warm-images --recover ${lease!.selector} --acknowledge-provider-cleanup`;
  expect((await detect())?.preview.join("\n")).toContain(command);
  const { changes, warnings } = await migrate();
  const warning = warnings.join("\n");
  expect(changes).toEqual([]);
  expect(warning).toContain("1 legacy Crabbox lease row(s)");
  expect(warning).toContain(command);
  expect(warning).toContain("stop the original Gateway/capture processes");
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
    vi.spyOn(store, "compareAndApply").mockImplementationOnce(async (...args) => {
      if (failure === "write-failed") {
        throw new Error("write unavailable");
      }
      await store.register(args[0], failure === "changed" ? newer : image, { ttlMs: 60_000 });
      return compareAndApply(...args);
    });
    vi.spyOn(params.context, "openPluginStateKeyedStore").mockImplementation((options) =>
      options.namespace === "warm-images" ? store : openStore(options),
    );
    const result = await migrate();
    const retried = failure === "metadata-conflict";
    expect([result.changes.length, result.warnings.length]).toEqual(retried ? [1, 0] : [0, 1]);
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
