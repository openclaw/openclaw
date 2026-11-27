import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareModelPricingContext, resolveModelPricing } from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { refreshRemoteModelCatalog } from "../model-catalog/remote-refresh.js";
import { readRemoteModelCatalogAsync } from "../model-catalog/remote-store.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { resolveDecisionModelSetting } from "./decision-model-setting.js";
import { buildAllowedModelSet } from "./model-selection.js";
import {
  catalogInput,
  createCatalogFixture,
  HARNESS_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import {
  acquireAgentRunPreparedModelRuntime,
  applyRemoteModelCatalogUpdate,
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
} from "./prepared-model-runtime.types.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

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
  const lease = await acquireAgentRunPreparedModelRuntime(input);
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

it("carries published task facts through HTTP, SQLite and prepared role selection", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const route: Pick<ModelProviderConfig, "api" | "baseUrl"> = {
    api: "openai-completions",
    baseUrl: "https://worker-catalog.invalid/v1",
  };
  const nativeBaseUrl = "https://native-worker-catalog.invalid/v1";
  const manifestFile = path.join(fixture.root, "plugin/openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  // Installed transport owns the route, but cannot supply the task facts being proved.
  manifest.modelCatalog.providers = {
    [PROVIDER_ID]: {
      ...route,
      models: [{ id: "sqlite-model" }, { id: "native", baseUrl: nativeBaseUrl }],
    },
  };
  manifest.modelCatalog.discovery = { [PROVIDER_ID]: "static" };
  writeJsonFile(manifestFile, manifest);
  const inference = {
    chat: false,
    decision: {
      protocol: "fixture.decisions",
      input: ["text"],
      questions: { boolean: { probabilities: "boolean", abstention: true } },
      limits: { maxQuestions: 32 },
      billing: { unit: "tokens", source: "provider-catalog", usdPerMillion: { input: 0 } },
    },
  };
  const publisherRoot = path.join(fixture.root, "publisher");
  writeJsonFile(path.join(publisherRoot, "extensions/fixture/openclaw.plugin.json"), {
    providers: ["anthropic", "openai", PROVIDER_ID],
    modelCatalog: {
      providers: {
        anthropic: { models: [{ id: "chat-a" }] },
        openai: { models: Array.from({ length: 199 }, (_, i) => ({ id: `chat-${i}` })) },
        [PROVIDER_ID]: {
          ...route,
          models: [
            { id: "native", baseUrl: nativeBaseUrl, inference },
            { id: "dual", inference: { ...inference, chat: true } },
            { id: "free" },
            { id: "unknown" },
          ],
        },
      },
    },
    modelPricing: { providers: { [PROVIDER_ID]: { openCode: { provider: "upstream" } } } },
  });
  writeJsonFile(path.join(publisherRoot, "scripts/lib/recommended-models.json"), []);
  await runPublishModelCatalog({
    rootDir: publisherRoot,
    sourceCommit: "fixture",
    args: ["--pricing", "--out", "v1.json", "--out-v3", "v3.json"],
    fetchImpl: async (url) => {
      if (url !== "https://models.opencode.ai/api.json") {
        throw new Error("unexpected publisher source");
      }
      return Response.json({
        upstream: {
          id: "upstream",
          models: { free: { id: "free", cost: { input: 0, output: 0 } } },
        },
      });
    },
  });
  const bytes = fs.readFileSync(path.join(publisherRoot, "v3.json"));
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", etag: '"task-catalog"' });
      response.end(bytes);
    },
    async (baseUrl) => {
      const config: OpenClawConfig = {
        ...fixture.config,
        agents: {
          defaults: {
            ...fixture.config.agents.defaults,
            decisionModel: `${PROVIDER_ID}/native`,
            models: {
              ...fixture.config.agents.defaults.models,
              [`${PROVIDER_ID}/dual`]: { agentRuntime: { id: HARNESS_ID } },
            },
          },
        },
        models: {
          catalogRefresh: { url: `${baseUrl}/v3.json` },
          providers: {
            [PROVIDER_ID]: {
              ...route,
              models: [
                {
                  id: "dual",
                  name: "Dual",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      };
      await withEnvAsync(fixture.env, async () => {
        setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt: () => 1 });
        expect(await prepareRemoteModelCatalogStartupSnapshot()).toBeNull();
        const input = catalogInput({ ...fixture, config });
        const before = await publishPreparedModelRuntimeSnapshot(input, {
          provenance: "configured",
          catalogMode: "static",
        });
        expect(before.modelCatalog.entries.some((row) => row.id === "native")).toBe(false);
        expect(await refreshRemoteModelCatalog({ config, force: true })).toMatchObject({
          status: "updated",
          models: 204,
        });
        // A download is inert until the existing rows/pricing publication owner adopts it.
        expect(captureRemoteModelCatalogStartupSnapshot()).toBeNull();
        expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
        await using lease = await acquireAgentRunPreparedModelRuntime(input);
        await lease.run(async () => {
          const rows = lease.snapshot.modelCatalog.entries;
          expect(rows.find((row) => row.id === "native")?.inference).toEqual(inference);
          expect(rows.find((row) => row.id === "dual")?.inference).toEqual({
            ...inference,
            chat: true,
          });
          const allowed = buildAllowedModelSet({
            cfg: config,
            catalog: rows,
            defaultProvider: PROVIDER_ID,
            manifestPlugins: lease.snapshot.metadataSnapshot,
          });
          expect(allowed.allowedCatalog.some((row) => row.id === "native")).toBe(false);
          expect(allowed.allowedCatalog.some((row) => row.id === "dual")).toBe(true);
          expect(resolveDecisionModelSetting(config)).toEqual({
            provider: PROVIDER_ID,
            model: "native",
          });
          const pricing = await prepareModelPricingContext(config);
          expect(resolveModelPricing(pricing, `${PROVIDER_ID}/free`)).toMatchObject({
            input: 0,
            output: 0,
          });
          expect(resolveModelPricing(pricing, `${PROVIDER_ID}/unknown`)).toBeUndefined();
        });
        const stored = await readRemoteModelCatalogAsync(captureOpenClawStateWorkerContext());
        const persisted = JSON.parse(stored!.bundle_json);
        expect(persisted.schemaVersion).toBe(3);
        expect(
          persisted.models.find((row: { id: string }) => row.id === "native").inference,
        ).toEqual(inference);
      });
    },
  );
});

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

it("relists an unchanged provider when a running Gateway adopts a hosted catalog", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  await withEnvAsync(fixture.env, async () => {
    const config: OpenClawConfig = {
      ...fixture.config,
      models: { catalogRefresh: { url: sourceUrl } },
    };
    const input = catalogInput({ ...fixture, config });
    const hosted: { stored?: ReturnType<typeof storedCatalog> } = {};
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 1,
      readStoredCatalog: () => hosted.stored,
    });
    expect(await prepareRemoteModelCatalogStartupSnapshot({ env: fixture.env })).toBeNull();
    const listings = () => fs.readFileSync(fixture.marker, "utf8").split("start\n").length - 1;
    const published = await publishPreparedModelRuntimeSnapshot(input, {
      provenance: "configured",
      catalogMode: "static",
    });
    await published.loadFullModelCatalog!({ refresh: true, wait: true });
    const before = listings();

    hosted.stored = storedCatalog(100);
    expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
    // Neither the provider's config nor its credentials changed; adoption still relists it.
    expect(listings()).toBe(before + 1);
    // The adopted generation publishes that listing; reading it starts no other listing.
    const { entries: rows } = await getPreparedModelRuntimeSnapshot(input)!.loadFullModelCatalog!();
    expect(rows.some((row) => row.id.startsWith(`proof-refresh-${before + 1}-`))).toBe(true);
    expect(listings()).toBe(before + 1);
  });
});
