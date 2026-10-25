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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { shortenHomePath } from "../utils.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./auth-profiles/path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
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
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { formatModelCatalogAuthLabel } from "./model-catalog-auth-labels.js";
import { withPreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthLabels,
  getPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { acquireReadOnlyPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

type RuntimeLease = Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>>;

function acquireStatic(input: PreparedModelRuntimeInput) {
  return acquireReadOnlyPreparedModelRuntime(input, { catalogMode: "static" });
}

const provider = "cold-auth-fixture";
const modelId = "fixture-model";
const apiKey = (providerId: string, key: string) =>
  ({ type: "api_key", provider: providerId, key }) as const;

function preparedAuth(snapshot: RuntimeLease["snapshot"]) {
  return expectDefined(getPreparedModelRuntimeAuthStore(snapshot), "prepared auth store");
}

function coldInput(
  state: OpenClawTestState,
  agentId = "main",
  providerId = provider,
): PreparedModelRuntimeInput {
  return {
    config: {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir, model: `${providerId}/${modelId}` } },
      ...providerConfig(providerId, {
        api: "openai-completions",
        baseUrl: "https://cold-auth.example.test/v1",
        models: [
          modelDefinition(modelId, {
            name: "Cold auth fixture model",
            reasoning: false,
            contextWindow: 8192,
            maxTokens: 1024,
          }),
        ],
      }),
    },
    agentId,
    agentDir: state.agentDir(agentId),
    workspaceDir: state.workspaceDir,
    env: state.env,
  };
}

function observeSql(resources: AsyncDisposableStack) {
  const observation = observeMainThreadSql({ includeClose: true });
  resources.defer(() => observation.restore());
  return observation;
}

function persistProfiles(
  state: OpenClawTestState,
  profiles: AuthProfileStore["profiles"],
  agentDir?: string,
) {
  runAuthProfileWriteTransaction(
    agentDir,
    (database) => writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir, database),
    { env: state.env },
  );
}

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
      const connections: Array<{ database: DatabaseSync; disposals: number }> = [];
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
    const connection = { database, disposals: 0 };
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
          let first: RuntimeLease | undefined;
          let replacement: typeof first;
          let firstRelease: Promise<void> | undefined;
          let projection: Promise<string[]> | undefined;
          try {
            first = await acquireStatic(input);
            const original = expectDefined(connections[0], "original provider registration");
            selectedSource.input = input;
            projection = withPreparedModelCatalogOwner(input, async (snapshot) => {
              const normalize = expectDefined(
                snapshot.pluginRegistry?.providers.find((entry) => entry.provider.id === pluginId)
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
            replacement = await acquireStatic(input);
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

it.each([false, true])("prepares scoped model auth and labels (env-only=%s)", async (envOnly) => {
  await withOpenClawTestState(
    { label: "scoped-model-catalog-auth", scenario: "minimal" },
    async (state) => {
      const providerId = envOnly ? "env-only-fixture" : provider;
      const profileId = `${providerId}:${envOnly ? "external" : "default"}`;
      const profile = apiKey(
        providerId,
        envOnly ? "synthetic-external-credential" : "synthetic-cold-auth-key",
      );
      const input = coldInput(state, "main", providerId);
      const { config, agentDir } = input;
      const publishedProfileIds = () =>
        Object.keys(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles ?? {});
      await using resources = new AsyncDisposableStack();
      resources.defer(() => {
        if (envOnly) {
          clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
        }
      });
      resources.defer(resetPreparedModelRuntimeSnapshotsForTest);
      let observation: ReturnType<typeof observeMainThreadSql> | undefined;
      let lease: RuntimeLease | undefined;
      if (envOnly) {
        prepareSharedAuthStoreOwnershipForNative(state.env);
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
        persistProfiles(state, { [profileId]: profile }, agentDir);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
        observation = observeSql(resources);
      }
      resources.defer(async () => {
        await lease?.[Symbol.asyncDispose]();
      });
      const verify = async () => {
        observation?.calibrate();
        lease = await acquireStatic({ ...input, inheritedAuthDir: agentDir });
        const { snapshot } = lease;
        expect(snapshot.findConfiguredRuntimeModel(providerId, modelId)).toMatchObject({
          provider: providerId,
          id: modelId,
          name: "Cold auth fixture model",
        });
        const authStore = preparedAuth(snapshot);
        if (envOnly) {
          expect(Object.keys(authStore.profiles)).toEqual([]);
          expect(snapshot.authModes[providerId]).toBeUndefined();
        } else {
          expect(authStore.profiles[profileId]).toEqual(profile);
        }
        const labels = expectDefined(
          getPreparedModelRuntimeAuthLabels(snapshot).get(providerId),
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
          const profileId = `${provider}:shared`;
          for (const [state, key] of [
            [ambient, "synthetic-ambient-key"],
            [selected, "synthetic-selected-key"],
          ] as const) {
            persistProfiles(state, { [profileId]: apiKey(provider, key) });
            expect(resolveSharedAuthStoreOwnership(state.env)).toEqual({ location: "state-db" });
            const sharedPath = resolveSharedAuthStorePath(state.env);
            expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(sharedPath)).toBeUndefined();
            await closeOpenClawStateDatabaseByPathAsync(sharedPath);
          }
          const input = coldInput(selected, "reader");
          const { agentDir } = input;
          persistProfiles(selected, {}, agentDir);
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
              await using resources = new AsyncDisposableStack();
              resources.defer(resetPreparedModelRuntimeSnapshotsForTest);
              const observation = observeSql(resources);
              let lease: RuntimeLease | undefined;
              observation.calibrate();
              const pending = acquireStatic(input).then((acquired) => (lease = acquired));
              resources.defer(async () => {
                resume.resolve();
                await Promise.allSettled([pending]);
                await lease?.[Symbol.asyncDispose]();
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
              expect(preparedAuth(lease.snapshot).profiles).toEqual({
                [profileId]: apiKey(provider, "synthetic-selected-key"),
              });
              await lease[Symbol.asyncDispose]();
              lease = undefined;
              observation.expectIdle();
            },
          );
        },
      );
    });
  },
);
