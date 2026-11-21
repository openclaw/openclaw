import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getTrackedWorkerPoolSnapshot } from "../infra/worker-cpu.js";
import { normalizePluginsConfigWithResolverCore } from "../plugins/config-normalization-shared.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  catalogEntry,
  catalogInput,
  createCatalogFixture,
  makeCatalogAgentFacts,
  PROVIDER_ID,
  DISCOVERED_HARNESS_ID,
  writeFixturePlugin,
  writeFixtureFiles,
} from "./prepared-model-catalog-worker.test-support.js";
import { prepareFullCatalogFacts } from "./prepared-model-runtime.full-catalog.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers } = usePreparedCatalogWorkerFixtures();

function writeStaticContextPlugin(root: string, id: string, staticCatalog = true): string {
  const marker = path.join(root, `${id}-imports.txt`);
  for (const artifact of ["source", "built"] as const) {
    const extension = artifact === "source" ? "cts" : "cjs";
    const pluginDir = path.join(root, ...(artifact === "built" ? ["dist"] : []), "extensions", id);
    fs.mkdirSync(pluginDir, { recursive: true });
    writeFixtureFiles(pluginDir, {
      "package.json": {
        name: id,
        version: "1.0.0",
        type: "commonjs",
        openclaw: {
          extensions: [`./index.${extension}`],
          build: { bundledDist: false, runtimeFormat: "cjs" },
        },
      },
      "openclaw.plugin.json": {
        id,
        providers: [id],
        enabledByDefault: true,
        activation: { onStartup: false },
        providerCatalogEntry: `./provider-discovery.${extension}`,
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      [`index.${extension}`]: 'throw new Error("Static context must not load the full plugin");\n',
      [`provider-discovery.${extension}`]: `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${artifact}\n`)});
module.exports = {
  id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)}, auth: [],
  ${staticCatalog ? "staticCatalog" : "catalog"}: {
    run: async () => ({ provider: {
      baseUrl: "https://catalog.example.test/v1", api: "openai-completions",
      models: [{ id: ${JSON.stringify(`${artifact}-model`)}, name: "Artifact model" }],
    } }),
  },
};\n`,
    });
  }
  return marker;
}

it.each([
  { scope: "selected", built: true },
  { scope: "all", built: true },
  { scope: "selected", built: false },
])("assembles $scope static context with built generation=$built", async ({ scope, built }) => {
  const root = makeTempDir("openclaw-catalog-static-context-");
  const selectedMarker = writeStaticContextPlugin(root, "selected");
  const siblingMarker = writeStaticContextPlugin(root, "sibling");
  const unrelatedMarker = writeStaticContextPlugin(root, "unrelated", false);
  const config: OpenClawConfig = {
    plugins: { allow: ["selected", "sibling", "unrelated"], slots: { memory: "none" } },
  };
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  };
  const input = {
    agentDir: path.join(root, "agent"),
    workspaceDir: path.join(root, "workspace"),
    config,
    env,
  };
  const cache = createPluginCache();
  const registry = built ? createEmptyPluginRegistry() : undefined;
  try {
    await withPluginCache(cache, async () => {
      const metadata = loadPluginMetadataSnapshot({ config, env, allowCurrent: false });
      if (registry) {
        prepareOwnedPluginLoadContext(input, env, registry, metadata, true);
      }
      const facts = await prepareFullCatalogFacts(
        makeCatalogAgentFacts(input),
        {
          pluginMetadataSnapshot: metadata,
          pluginRegistry: registry,
        },
        "live",
        { modelsJsonContents: null, pluginCatalogs: [] },
        { includeNative: false, ...(scope === "selected" ? { providerIds: ["selected"] } : {}) },
      );

      expect(fs.existsSync(unrelatedMarker)).toBe(scope === "all");
      expect(fs.existsSync(siblingMarker)).toBe(scope === "all");
      const artifact = built ? "built" : "source";
      expect(fs.readFileSync(selectedMarker, "utf8")).toBe(`${artifact}\n`);
      expect(facts.modelCatalog.staticEntries?.map(({ provider, id }) => [provider, id])).toEqual(
        (scope === "all" ? ["selected", "sibling"] : ["selected"]).map((provider) => [
          provider,
          `${artifact}-model`,
        ]),
      );
    });
  } finally {
    if (registry) {
      await disposePluginRegistryInstances(registry);
    }
    await retirePluginCache(cache);
  }
});

it("startSerializedSnapshotBuildBatch retains canonical metadata through catalog and native auth requests", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const { config, env, workspaceDir } = fixture;
  const cache = createPluginCache();
  const metadata = withPluginCache(cache, () =>
    loadPluginMetadataSnapshot({ config, env, workspaceDir, allowCurrent: false }),
  );
  const input = catalogInput(fixture);
  const retirement = new AbortController();
  const isCurrent = () => !retirement.signal.aborted;
  retireAfterTest(() => retirement.abort());

  // The operation retains canonical metadata across module evaluation.
  vi.resetModules();
  const [runtimeBuild, providerRuntime, metadataRuntime, generationScope] = await Promise.all([
    import("./prepared-model-runtime.build.js"),
    import("../plugins/provider-runtime.js"),
    import("../plugins/current-plugin-metadata-snapshot.js"),
    import("../plugins/runtime/generation-scope.js"),
  ]);
  let registry: PluginRegistry | undefined;
  const capture = providerRuntime.captureProviderSyntheticAuthFacts;
  const captureSpy = vi
    .spyOn(providerRuntime, "captureProviderSyntheticAuthFacts")
    .mockImplementation((params) => {
      expect(metadataRuntime.getCurrentPluginMetadataSnapshot()).toBe(metadata);
      expect(generationScope.getPluginRuntimeGenerationRegistry()).toBe(registry);
      expect(getPluginMetadataSnapshotCache(metadata)).toBe(cache);
      return capture(params);
    });
  try {
    await withPluginCache(cache, async () => {
      const build = runtimeBuild.startSerializedSnapshotBuildBatch(
        [
          {
            input,
            catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
            isGenerationCurrent: isCurrent,
            retirementSignal: retirement.signal,
            isBuildCurrent: isCurrent,
          },
        ],
        new Map(),
        30_000,
        "static",
        undefined,
        metadata,
      );
      const [prepared] = await (async () => {
        try {
          return await build.pending;
        } finally {
          await build.completion;
        }
      })();
      if (!prepared) {
        throw new Error("prepared runtime produced no snapshot");
      }
      registry = prepared.pluginGeneration.pluginRegistry;
      expect(registry).toBeDefined();
      expect(prepared.snapshot.metadataSnapshot).toBe(metadata);
      expect(metadata.normalizePluginId(` ${PROVIDER_ID.toUpperCase()} `)).toBe(PROVIDER_ID);
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(captureSpy).not.toHaveBeenCalled();
      await waitForWorkers();

      // Full-result assertions require acquisition, not the bounded foreground snapshot.
      const catalog = await prepared.snapshot.loadFullModelCatalog!({ refresh: true, wait: true });
      expect(captureSpy).toHaveBeenCalled();
      expect(catalog.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
    });
  } finally {
    retirement.abort();
    try {
      await waitForWorkers();
    } finally {
      captureSpy.mockRestore();
      if (registry) {
        await disposePluginRegistryInstances(registry);
      }
      await retirePluginCache(cache);
    }
  }
});

const script = "prepared-model-catalog.worker.js";
const catalogPools = () =>
  getTrackedWorkerPoolSnapshot().workerPools.filter((pool) => pool.script === script);

describe("prepared worker alias-policy admission", () => {
  // Exercise real worker admission, registration, and retained-generation refresh with authored aliases.
  it.each([
    { policy: "enabled alias entry", included: true },
    { policy: "alias deny", included: false },
    { policy: "disabled alias entry", included: false },
  ])(
    "admitted worker respects $policy across retained-generation refresh",
    async ({ policy, included }) => {
      const fixture = await createCatalogFixture(makeTempDir, 0);
      const alias = " " + DISCOVERED_HARNESS_ID.toUpperCase() + " ";
      const config: OpenClawConfig = {
        ...fixture.config,
        plugins: {
          ...fixture.config.plugins,
          allow: [PROVIDER_ID],
          ...(policy === "alias deny" ? { deny: [alias] } : {}),
          entries: { [alias]: { enabled: policy !== "disabled alias entry" } },
        },
      };
      const cache = createPluginCache();
      const retirement = new AbortController();
      retireAfterTest(() => retirement.abort());
      const receipts: unknown[] = [];
      const taskEvents = channel("openclaw.worker.task");
      const observe = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "worker" in message &&
          message.worker === script
        ) {
          receipts.push(message);
        }
      };
      taskEvents.subscribe(observe);
      try {
        await withPluginCache(cache, async () => {
          expect(catalogPools()).toEqual([]);
          const metadata = loadPluginMetadataSnapshot({
            config,
            env: fixture.env,
            workspaceDir: fixture.workspaceDir,
            allowCurrent: false,
          });
          expect(metadata.normalizePluginId(alias)).toBe(PROVIDER_ID);
          const plugin = metadata.byPluginId.get(PROVIDER_ID);
          if (!plugin) {
            throw new Error("real fixture manifest missing");
          }
          // Base admission and later loader scope growth must agree with discovery policy.
          expect(
            isManifestPluginAvailableForControlPlane({
              snapshot: metadata,
              plugin,
              config,
              normalizedConfig: normalizePluginsConfigWithResolverCore(
                config.plugins,
                metadata.normalizePluginId,
              ),
              env: fixture.env,
            }),
          ).toBe(included);
          const worker = createPreparedModelCatalogWorker({
            agentFacts: makeCatalogAgentFacts(catalogInput({ ...fixture, config })),
            pluginMetadataSnapshot: metadata,
            isCurrent: () => !retirement.signal.aborted,
            retirementSignal: retirement.signal,
          });
          const first = await worker.loadCatalog();
          const firstRows = new Set(
            first.modelCatalog.entries
              .filter((entry) => entry.provider === PROVIDER_ID)
              .map((entry) => entry.id),
          );
          expect(firstRows.has("plugin-generation-v1")).toBe(included);
          expect(firstRows.has("plugin-generation-v2")).toBe(false);
          expect(fs.existsSync(fixture.marker)).toBe(included);
          expect(fs.existsSync(path.join(fixture.root, "runtime-artifact-paths.txt"))).toBe(
            included,
          );
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({ worker: script, outcome: "ok" });
          const firstPools = catalogPools();
          expect(firstPools).toHaveLength(1);
          expect(firstPools[0]?.workerCount).toBe(1);
          // This source change must not silently replace the prepared worker generation.
          writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
          const second = await worker.loadCatalog(undefined, undefined, true);
          const secondRows = new Set(
            second.modelCatalog.entries
              .filter((entry) => entry.provider === PROVIDER_ID)
              .map((entry) => entry.id),
          );
          expect(secondRows.has("plugin-generation-v1")).toBe(included);
          expect(secondRows.has("plugin-generation-v2")).toBe(false);
          expect(fs.existsSync(fixture.marker)).toBe(included);
          expect(fs.existsSync(path.join(fixture.root, "runtime-artifact-paths.txt"))).toBe(
            included,
          );
          if (included) {
            expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\nstart\ndone\n");
          }
          expect(receipts).toHaveLength(2);
          expect(receipts[1]).toMatchObject({ worker: script, outcome: "ok" });
          expect(catalogPools()).toEqual(firstPools);
        });
      } finally {
        retirement.abort();
        await retirePluginCache(cache);
        await waitForWorkers();
        taskEvents.unsubscribe(observe);
      }
    },
  );
});
