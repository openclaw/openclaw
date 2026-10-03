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
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { shortenHomePath } from "../utils.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./auth-profiles/path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import * as authRows from "./auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import { withEnvOnlyAuthProfileStore } from "./auth-profiles/store.js";
import { formatModelCatalogAuthLabel } from "./model-catalog-auth-labels.js";
import { withPreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthLabels,
  getPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
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
          let firstRelease: Promise<void> | undefined;
          let projection: Promise<string[]> | undefined;
          try {
            first = await acquireReadOnlyPreparedModelRuntime(input, { catalogMode: "static" });
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
              firstRelease = first[Symbol.asyncDispose]();
              void firstRelease.catch(() => {});
            }
            await Promise.race([
              entered.promise,
              projection.then(() => {
                throw new Error("Projection did not enter the published owner");
              }),
            ]);
            if (!releaseBeforeCallback) {
              firstRelease = first[Symbol.asyncDispose]();
              void firstRelease.catch(() => {});
            }
            replacement = await acquireReadOnlyPreparedModelRuntime(input, {
              catalogMode: "static",
            });
            expect(connections).toHaveLength(2);
            const successor = expectDefined(connections[1], "replacement provider registration");
            expect(original.database.isOpen).toBe(true);
            resume.resolve();
            expect(await result).toEqual(
              outcome === "reject" ? { error: failure } : { rows: ["42"] },
            );
            await firstRelease;
            await expect.poll(() => original.disposals).toBe(1);
            expect(original.database.isOpen).toBe(false);
            expect(successor.database.isOpen).toBe(true);
            const reopened = new DatabaseSync(original.file, { readOnly: true });
            try {
              expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
            } finally {
              reopened.close();
            }
            await replacement[Symbol.asyncDispose]();
            await expect.poll(() => successor.disposals).toBe(1);
          } finally {
            resume.resolve();
            await Promise.allSettled([projection]);
            selectedSource.input = undefined;
            await Promise.all([
              firstRelease,
              first?.[Symbol.asyncDispose](),
              replacement?.[Symbol.asyncDispose](),
            ]);
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

function coldCatalogConfig(
  workspaceDir: string,
  provider: string,
  modelId: string,
): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: { workspace: workspaceDir, model: `${provider}/${modelId}` },
    },
    models: {
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "https://cold-auth.example.test/v1",
          models: [
            {
              id: modelId,
              name: "Cold auth fixture model",
              reasoning: false,
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
}

it.each([false, true])("prepares scoped model auth and labels (env-only=%s)", async (envOnly) => {
  await withOpenClawTestState(
    { label: "scoped-model-catalog-auth", scenario: "minimal" },
    async (state) => {
      const provider = envOnly ? "env-only-fixture" : "cold-auth-fixture";
      const modelId = "fixture-model";
      const profileId = `${provider}:${envOnly ? "external" : "default"}`;
      const profile = {
        type: "api_key" as const,
        provider,
        key: envOnly ? "synthetic-external-credential" : "synthetic-cold-auth-key",
      };
      const agentDir = state.agentDir("main");
      const config = coldCatalogConfig(state.workspaceDir, provider, modelId);
      const publishedProfileIds = () =>
        Object.keys(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles ?? {});
      let observation: ReturnType<typeof observeMainThreadSql> | undefined;
      let lease: Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>> | undefined;
      try {
        if (envOnly) {
          setRuntimeAuthProfileStoreSnapshot(
            {
              version: 1,
              profiles: { [profileId]: profile },
              runtimeExternalProfileIds: [profileId],
              runtimeExternalProfileIdsAuthoritative: true,
            },
            agentDir,
          );
          expect(publishedProfileIds()).toEqual([profileId]);
        } else {
          // Persist credentials without publishing the previous process's warm runtime view.
          runAuthProfileWriteTransaction(
            agentDir,
            (database) =>
              writePersistedAuthProfileStoreRaw(
                { version: 1, profiles: { [profileId]: profile } },
                agentDir,
                database,
              ),
            { env: state.env },
          );
          expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
          await closeOpenClawAgentDatabasesAsync(state.stateDir);
          observation = observeMainThreadSql({ includeClose: true });
        }
        const verify = async () => {
          observation?.calibrate();
          lease = await acquireReadOnlyPreparedModelRuntime(
            {
              config,
              agentId: "main",
              agentDir,
              inheritedAuthDir: agentDir,
              workspaceDir: state.workspaceDir,
              env: state.env,
            },
            { catalogMode: "static" },
          );
          const { snapshot } = lease;
          expect(snapshot.findConfiguredRuntimeModel(provider, modelId)).toMatchObject({
            provider,
            id: modelId,
            name: "Cold auth fixture model",
          });
          const authStore = expectDefined(
            getPreparedModelRuntimeAuthStore(snapshot),
            "prepared auth store",
          );
          if (envOnly) {
            expect(Object.keys(authStore.profiles)).toEqual([]);
            expect(snapshot.authModes[provider]).toBeUndefined();
          } else {
            expect(authStore.profiles[profileId]).toEqual(profile);
          }
          const labels = expectDefined(
            getPreparedModelRuntimeAuthLabels(snapshot).get(provider),
            "provider auth labels",
          );
          const label = formatModelCatalogAuthLabel(labels.all, {
            cfg: config,
            store: authStore,
            metadataSnapshot: snapshot.metadataSnapshot,
          });
          if (envOnly) {
            expect(label).toBe("missing");
          } else {
            expect(label).toContain(`${profileId}=`);
            expect(label).not.toContain("missing");
            expect(label).toContain(
              `auth profile store: ${shortenHomePath(resolveAuthProfileDatabasePath(agentDir))}`,
            );
          }
          await lease[Symbol.asyncDispose]();
          lease = undefined;
          observation?.expectIdle();
        };
        if (envOnly) {
          await withEnvOnlyAuthProfileStore(verify);
          expect(publishedProfileIds()).toEqual([profileId]);
        } else {
          await verify();
        }
      } finally {
        try {
          await lease?.[Symbol.asyncDispose]();
        } finally {
          observation?.restore();
          try {
            await resetPreparedModelRuntimeSnapshotsForTest();
          } finally {
            if (envOnly) {
              clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
            }
          }
        }
      }
    },
  );
});

it.each(["explicit root", "ambient changes after capture"] as const)(
  "keeps cold model auth on its requested environment: %s",
  async (scenario) => {
    await withOpenClawTestState({ label: "model-auth-ambient" }, async (ambient) => {
      await withOpenClawTestState(
        { label: "model-auth-selected", applyEnv: false },
        async (selected) => {
          const provider = "cold-auth-fixture";
          const modelId = "fixture-model";
          const profileId = `${provider}:shared`;
          for (const [state, key] of [
            [ambient, "synthetic-ambient-key"],
            [selected, "synthetic-selected-key"],
          ] as const) {
            runAuthProfileWriteTransaction(
              undefined,
              (database) =>
                writePersistedAuthProfileStoreRaw(
                  { version: 1, profiles: { [profileId]: { type: "api_key", provider, key } } },
                  undefined,
                  database,
                ),
              { env: state.env },
            );
            expect(resolveSharedAuthStoreOwnership(state.env)).toEqual({ location: "state-db" });
            const sharedPath = resolveSharedAuthStorePath(state.env);
            expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(sharedPath)).toBeUndefined();
            await closeOpenClawStateDatabaseByPathAsync(sharedPath);
          }
          const agentDir = selected.agentDir("reader");
          runAuthProfileWriteTransaction(
            agentDir,
            (database) =>
              writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir, database),
            { env: selected.env },
          );
          expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
          await closeOpenClawAgentDatabasesAsync(ambient.stateDir);
          await closeOpenClawAgentDatabasesAsync(selected.stateDir);
          const hold = scenario === "ambient changes after capture";
          const entered = createDeferredCore();
          const resume = createDeferredCore();
          const readShared = authRows.readSharedAuthProfileRows;
          const selectedSharedPath = resolveSharedAuthStorePath(selected.env);
          let held = false;
          using _ = vi
            .spyOn(authRows, "readSharedAuthProfileRows")
            .mockImplementation(async (context) => {
              const rows = await readShared(context);
              if (hold && context.admission.databasePath === selectedSharedPath && !held) {
                held = true;
                entered.resolve();
                await resume.promise;
              }
              return rows;
            });
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: hold ? selected.stateDir : ambient.stateDir,
              OPENCLAW_AGENT_DIR: undefined,
            },
            async () => {
              const observation = observeMainThreadSql({ includeClose: true });
              let lease:
                | Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>>
                | undefined;
              let pending: ReturnType<typeof acquireReadOnlyPreparedModelRuntime> | undefined;
              try {
                observation.calibrate();
                pending = acquireReadOnlyPreparedModelRuntime(
                  {
                    config: coldCatalogConfig(selected.workspaceDir, provider, modelId),
                    agentId: "reader",
                    agentDir,
                    workspaceDir: selected.workspaceDir,
                    env: selected.env,
                  },
                  { catalogMode: "static" },
                ).then((acquired) => {
                  lease = acquired;
                  return acquired;
                });
                if (hold) {
                  await Promise.race([
                    entered.promise,
                    pending.then(() => {
                      throw new Error("Cold auth acquisition completed before its source gate");
                    }),
                  ]);
                  process.env.OPENCLAW_STATE_DIR = ambient.stateDir;
                  resume.resolve();
                }
                lease = await pending;
                expect(lease.snapshot.findConfiguredRuntimeModel(provider, modelId)).toMatchObject({
                  provider,
                  id: modelId,
                });
                const authStore = expectDefined(
                  getPreparedModelRuntimeAuthStore(lease.snapshot),
                  "selected environment auth store",
                );
                expect(authStore.profiles[profileId]).toEqual({
                  type: "api_key",
                  provider,
                  key: "synthetic-selected-key",
                });
                expect(Object.keys(authStore.profiles)).toEqual([profileId]);
                await lease[Symbol.asyncDispose]();
                lease = undefined;
                observation.expectIdle();
              } finally {
                resume.resolve();
                try {
                  await Promise.allSettled(pending ? [pending] : []);
                  await lease?.[Symbol.asyncDispose]();
                } finally {
                  observation.restore();
                  await resetPreparedModelRuntimeSnapshotsForTest();
                }
              }
            },
          );
        },
      );
    });
  },
);
