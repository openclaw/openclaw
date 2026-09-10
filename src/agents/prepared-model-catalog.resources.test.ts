import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import { acquireReadOnlyPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const selectedSource = vi.hoisted(() => ({
  input: undefined as PreparedModelRuntimeInput | undefined,
}));

// Select an existing managed publication without enabling configured producer disposal.
vi.mock("./prepared-model-runtime.js", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("./prepared-model-runtime.js")>();
  return {
    ...runtime,
    prepareModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) =>
      runtime.prepareModelRuntimeSnapshot(selectedSource.input ?? input),
    acquirePreparedModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) =>
      runtime.acquirePreparedModelRuntimeSnapshot(selectedSource.input ?? input),
  };
});

it.each([
  { outcome: "complete", releaseBeforeCallback: false },
  { outcome: "reject", releaseBeforeCallback: false },
  { outcome: "complete", releaseBeforeCallback: true },
])(
  "keeps SQLite through catalog projection ($outcome, releaseBeforeCallback=$releaseBeforeCallback)",
  async ({ outcome, releaseBeforeCallback }) => {
    await withOpenClawTestState({ label: "catalog-projection-resources" }, async (state) => {
      const pluginId = "catalog-projection-provider";
      const pluginRoot = state.path("plugin");
      const emptyBundled = state.path("empty-bundled");
      fs.mkdirSync(pluginRoot);
      fs.mkdirSync(emptyBundled);
      const fixture = createColdPluginFixture({
        rootDir: pluginRoot,
        pluginId,
        providerId: pluginId,
        manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      const key = `__catalog_projection_${path.basename(state.root)}`;
      const connections: Array<{ file: string; database: DatabaseSync; disposals: number }> = [];
      Object.defineProperty(globalThis, key, { configurable: true, value: connections });
      fs.writeFileSync(
        fixture.runtimeSource,
        `
const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    const connections = globalThis[${JSON.stringify(key)}];
    const file = ${JSON.stringify(state.root)} + "/registration-" + connections.length + ".sqlite";
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
    const connection = { file, database, disposals: 0 };
    connections.push(connection);
    api.lifecycle.registerRuntimeLifecycle({ id: "database", dispose() {
      connection.disposals++;
      database.close();
    } });
    api.registerProvider({
      id: ${JSON.stringify(pluginId)}, label: "Fixture provider", auth: [],
      normalizeModelId: () => String(database.prepare("SELECT value FROM answer").get().value),
    });
  },
};
`,
      );
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        plugins: {
          load: { paths: [pluginRoot] },
          slots: { memory: "none" },
          entries: { [pluginId]: { enabled: true } },
        },
      };
      const input: PreparedModelRuntimeInput = {
        config,
        agentId: "main",
        agentDir: state.agentDir("main"),
        workspaceDir: state.workspaceDir,
        readOnly: true,
        loadRuntimePlugins: true,
        skipCredentials: true,
        runtimePluginSelections: [{ provider: pluginId, modelId: "model", agentId: "main" }],
      };
      await withEnvAsync(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: emptyBundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          const entered = createDeferredCore();
          const resume = createDeferredCore();
          const failure = new Error("catalog projection failed");
          let first: Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>> | undefined;
          let replacement: typeof first;
          let projection: Promise<string[]> | undefined;
          try {
            first = await acquireReadOnlyPreparedModelRuntime(input, undefined, "static");
            expect(connections).toHaveLength(1);
            const original = expectDefined(connections[0], "original provider registration");
            selectedSource.input = input;
            projection = withPreparedModelCatalogOwner(input, async (snapshot) => {
              const normalize = expectDefined(
                snapshot.pluginRegistry?.providers.find(({ provider }) => provider.id === pluginId)
                  ?.provider.normalizeModelId,
                "registered catalog hook",
              );
              entered.resolve();
              await resume.promise;
              const row = normalize({ provider: pluginId, modelId: "model" });
              if (outcome === "reject") {
                throw failure;
              }
              return [String(row)];
            });
            const result = projection.then(
              (rows) => ({ rows }),
              (error: unknown) => ({ error }),
            );
            if (releaseBeforeCallback) {
              first.release();
            }
            await Promise.race([
              entered.promise,
              projection.then(() => {
                throw new Error("Projection did not enter the published owner");
              }),
            ]);
            if (!releaseBeforeCallback) {
              first.release();
            }
            replacement = await acquireReadOnlyPreparedModelRuntime(input, undefined, "static");
            expect(connections).toHaveLength(2);
            const successor = expectDefined(connections[1], "replacement provider registration");
            expect(original.database.isOpen).toBe(true);
            resume.resolve();
            expect(await result).toEqual(
              outcome === "reject" ? { error: failure } : { rows: ["42"] },
            );
            await expect.poll(() => original.disposals).toBe(1);
            expect(original.database.isOpen).toBe(false);
            expect(successor.database.isOpen).toBe(true);
            const reopened = new DatabaseSync(original.file, { readOnly: true });
            try {
              expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
            } finally {
              reopened.close();
            }
            replacement.release();
            await expect.poll(() => successor.disposals).toBe(1);
          } finally {
            resume.resolve();
            await Promise.allSettled([projection]);
            selectedSource.input = undefined;
            first?.release();
            replacement?.release();
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
            for (const connection of connections) {
              if (connection.database.isOpen) {
                connection.database.close();
              }
            }
            Reflect.deleteProperty(globalThis, key);
          }
        },
      );
    });
  },
);
