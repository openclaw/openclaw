import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  catalogInput,
  createCatalogFixture,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { scopePreparedModelRuntimeLease } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  applyRemoteModelCatalogUpdate,
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
type PreparedModelRuntimeLease = ReturnType<typeof scopePreparedModelRuntimeLease>;
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

async function collectForRetentionCheck(_label: string) {
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass++) {
    await setImmediate();
    queryObjects(WeakRef);
  }
  expect(control.deref()).toBeUndefined();
}

const sourceUrl = "https://catalog-retention.invalid/catalog.json";
const modelCount = 256;
const retentionRoute = {
  api: "openai-completions" as const,
  baseUrl: "https://worker-catalog.invalid/v1",
};

function storedCatalog(revision: number) {
  return {
    id: 1,
    source_url: sourceUrl,
    generated_at: revision,
    min_version: null,
    etag: null,
    last_modified: null,
    checked_at: revision,
    bundle_json: JSON.stringify({
      schemaVersion: 1,
      sourceCommit: "retention-fixture",
      generatedAt: revision,
      providers: {
        [PROVIDER_ID]: {
          ...retentionRoute,
          models: Array.from({ length: modelCount }, (_, index) => ({
            id: `revision-${revision}-${index}`,
            name: `Revision ${revision} model ${index}`,
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
      pricing: {},
    }),
  };
}

type References = Record<string, WeakRef<object>>;

async function captureGeneration(
  input: PreparedModelRuntimeInput,
  revision: number,
  leases: Map<number, PreparedModelRuntimeLease>,
): Promise<References> {
  const lease = scopePreparedModelRuntimeLease(await acquireAgentRunPreparedModelRuntime(input));
  leases.set(revision, lease);
  const snapshot = getPreparedModelRuntimeSnapshot(input);
  expect(snapshot).toBeDefined();
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot!);
  expect(owner).toBeDefined();
  const catalog = await snapshot!.loadFullModelCatalog!({ refresh: true, wait: true });
  const modelId = `revision-${revision}-0`;
  const entry = catalog.entries.find(
    (model) => model.provider === PROVIDER_ID && model.id === modelId,
  );
  const variant = catalog.routeVariants.find(
    (model) => model.provider === PROVIDER_ID && model.id === modelId,
  );
  // The fixture's live provider returns sqlite-model; remote rows enter through metadata.
  // Track that independently published runtime object, not an absent runtime discovery row.
  const runtimeModel = snapshot!.readPublishedModels!()
    ?.get(PROVIDER_ID)
    ?.find((model) => model.id === "sqlite-model");
  const remote = lease.pluginGeneration.remoteCatalog;
  expect(remote?.generatedAt).toBe(revision);
  expect(entry).toBeDefined();
  expect(variant).toBeDefined();
  expect(runtimeModel).toBeDefined();
  expect(remote?.providers[PROVIDER_ID]?.models).toHaveLength(modelCount);
  return {
    owner: new WeakRef(owner!),
    generation: new WeakRef(lease.pluginGeneration),
    remote: new WeakRef(remote!),
    remoteRow: new WeakRef(remote!.providers[PROVIDER_ID]!.models![0]!),
    catalogRow: new WeakRef(entry!),
    routeRow: new WeakRef(variant!),
    runtimeModel: new WeakRef(runtimeModel!),
  };
}

async function releaseLease(leases: Map<number, PreparedModelRuntimeLease>, revision: number) {
  const lease = leases.get(revision);
  leases.delete(revision);
  await lease?.[Symbol.asyncDispose]();
}

function expectLeaseRevision(lease: PreparedModelRuntimeLease, revision: number) {
  lease.run(() => {
    expect(lease.pluginGeneration.remoteCatalog?.generatedAt).toBe(revision);
    expect(
      lease.snapshot.modelCatalog.entries.some(
        (model) => model.provider === PROVIDER_ID && model.id === `revision-${revision}-0`,
      ),
    ).toBe(true);
  });
}

function liveReferences(references: References) {
  const { remote, remoteRow, ...owned } = references;
  return {
    owned: Object.fromEntries(
      Object.entries(owned).map(([name, reference]) => [name, reference.deref() !== undefined]),
    ),
    remote: { root: remote!.deref() !== undefined, row: remoteRow!.deref() !== undefined },
  };
}

it("releases remote catalog predecessors while the current publication and its callbacks remain live", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const manifestPath = path.join(fixture.root, "plugin/openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.modelCatalog.providers = {
    [PROVIDER_ID]: { ...retentionRoute, models: [{ id: "sqlite-model" }] },
  };
  manifest.modelCatalog.discovery = { [PROVIDER_ID]: "static" };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  await withEnvAsync(fixture.env, async () => {
    const config: OpenClawConfig = {
      ...fixture.config,
      models: { catalogRefresh: { url: sourceUrl } },
    };
    const input = catalogInput({ ...fixture, config });
    const leases = new Map<number, PreparedModelRuntimeLease>();
    let stored: ReturnType<typeof storedCatalog> | undefined;
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 1,
      readStoredCatalog: () => stored,
    });
    try {
      // Workers start with absence, so an inherited startup snapshot cannot pin A.
      expect(await prepareRemoteModelCatalogStartupSnapshot({ env: fixture.env })).toBeNull();
      await publishPreparedModelRuntimeSnapshot(input, {
        provenance: "configured",
        catalogMode: "static",
      });
      const adopt = async (revision: number) => {
        stored = storedCatalog(revision);
        expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
        expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(revision);
        return captureGeneration(input, revision, leases);
      };
      const a = await adopt(100);
      const b = await adopt(200);
      expect(b.runtimeModel!.deref()).not.toBe(a.runtimeModel!.deref());
      expectLeaseRevision(leases.get(100)!, 100);
      expectLeaseRevision(leases.get(200)!, 200);
      await releaseLease(leases, 100);
      // Fixture spies must not retain worker/build arguments after their work settles.
      vi.clearAllMocks();
      await collectForRetentionCheck("remote-publication-a-b");
      const afterB = { a: liveReferences(a), b: liveReferences(b) };
      await leases.get(200)!.run(async () => {
        const snapshot = leases.get(200)!.snapshot;
        const catalog = await snapshot.loadFullModelCatalog!({ refresh: true, wait: true });
        expect(
          catalog.entries.some(
            (row) => row.provider === PROVIDER_ID && row.id === "revision-200-0",
          ),
        ).toBe(true);
        await expect(
          loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] }),
        ).resolves.toMatchObject({ authStore: { version: 1 } });
      });

      const c = await adopt(300);
      expect(c.runtimeModel!.deref()).not.toBe(b.runtimeModel!.deref());
      expectLeaseRevision(leases.get(200)!, 200);
      expectLeaseRevision(leases.get(300)!, 300);
      await releaseLease(leases, 200);
      vi.clearAllMocks();
      await collectForRetentionCheck("remote-publication-a-b-c");
      const afterC = { a: liveReferences(a), b: liveReferences(b), c: liveReferences(c) };

      // C stays published throughout collection. Closing the runtime would hide a chain.
      expect(getPreparedModelRuntimeSnapshot(input)?.isCurrent()).toBe(true);
      const released = Object.fromEntries(Object.keys(afterB.a.owned).map((name) => [name, false]));
      const retained = Object.fromEntries(Object.keys(afterB.b.owned).map((name) => [name, true]));
      expect(afterB.b).toEqual({ owned: retained, remote: { root: true, row: true } });
      expect(afterC.c).toEqual({ owned: retained, remote: { root: true, row: true } });
      expect({ afterB: afterB.a.owned, a: afterC.a.owned, b: afterC.b.owned }).toEqual({
        afterB: released,
        a: released,
        b: released,
      });
      // Raw catalog data also has a pricing-deadline owner, separate from the callbacks above.
      expect([afterB.a.remote, afterC.a.remote, afterC.b.remote]).toEqual(
        Array.from({ length: 3 }, () => ({ root: false, row: false })),
      );
    } finally {
      await Promise.all([...leases.keys()].map((revision) => releaseLease(leases, revision)));
    }
  });
});
