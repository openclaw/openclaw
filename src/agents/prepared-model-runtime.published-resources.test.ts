import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { runBtwSideQuestion } from "./btw.js";
import { makeModel } from "./embedded-agent-runner/model.test-harness.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  acquireAgentRunPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import { observeSettlement } from "./promise-settlement.test-support.js";

function fixtureProvider(name = "model", apiKey = "synthetic-test-key") {
  return {
    api: "openai-completions" as const,
    apiKey,
    baseUrl: "https://fixture.invalid/v1",
    models: [{ ...makeModel("model"), name, contextWindow: 8192, maxTokens: 1024 }],
  };
}

function runtimeFixture(
  rootDir: string,
  pluginId: string,
  manifest: Record<string, unknown>,
  providerId?: string,
) {
  fs.mkdirSync(rootDir);
  return createColdPluginFixture({
    rootDir,
    pluginId,
    providerId,
    manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [], ...manifest },
  });
}

const selectedSource = vi.hoisted<{
  input?: PreparedModelRuntimeInput;
  acquisition?: { entered: () => void; completion: Promise<void> };
}>(() => ({}));

// Exercise BTW against an already-owned source without enabling configured producer disposal.
vi.mock("./prepared-model-runtime.js", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("./prepared-model-runtime.js")>();
  return {
    ...runtime,
    loadPreparedModelRuntimeSnapshot: (
      input: Parameters<typeof runtime.loadPreparedModelRuntimeSnapshot>[0],
    ) => runtime.loadPreparedModelRuntimeSnapshot(selectedSource.input ?? input),
    acquirePublishedPreparedModelRuntime: async (
      input: Parameters<typeof runtime.acquirePublishedPreparedModelRuntime>[0],
    ) => {
      const lease = await runtime.acquirePublishedPreparedModelRuntime(
        selectedSource.input ?? input,
      );
      selectedSource.acquisition?.entered();
      await selectedSource.acquisition?.completion;
      return lease;
    },
  };
});

it.each(["BTW parent close", "BTW parent close during acquisition"])(
  "retains an acquired SQLite source through %s and replacement",
  async (mode) => {
    await withOpenClawTestState(
      { label: "published-runtime-resources", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const pluginId = "published-runtime-provider";
        const pluginRoot = state.path("plugin");
        const fixture = runtimeFixture(
          pluginRoot,
          pluginId,
          {
            startup: { agentHarnesses: [pluginId] },
            modelCatalog: {
              providers: {
                [pluginId]: {
                  discovery: "static",
                  api: "openai-completions",
                  baseUrl: "https://fixture.invalid/v1",
                  models: [{ id: "model", name: "Fixture model", input: ["text"] }],
                },
              },
            },
          },
          pluginId,
        );
        const key = `__published_runtime_resources_${path.basename(state.root)}`;
        const connections: Array<{ database: DatabaseSync; disposals: number }> = [];
        const requestSignal: { current?: AbortSignal } = {};
        const abortRegistry: { current?: ReturnType<typeof getPluginRuntimeGenerationRegistry> } =
          {};
        const bridge = {
          connections,
          getRequestSignal: getSessionMcpRequestSignal,
          getRegistry: getPluginRuntimeGenerationRegistry,
          requestSignal,
          abortRegistry,
          abortObserved: createDeferredCore(),
          entered: createDeferredCore(),
          finish: createDeferredCore(),
          cleanupEntered: createDeferredCore(),
          cleanupFinish: createDeferredCore(),
        };
        Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
        fs.writeFileSync(
          fixture.runtimeSource,
          `
const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    const bridge = globalThis[${JSON.stringify(key)}];
    const connections = bridge.connections;
    const file = ${JSON.stringify(state.root)} + "/registration-" + connections.length + ".sqlite";
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
    const connection = { database, disposals: 0 };
    connections.push(connection);
    api.lifecycle.registerRuntimeLifecycle({ id: "database", dispose() {
      connection.disposals++;
      database.close();
    } });
    api.registerProvider({ id: ${JSON.stringify(pluginId)}, label: "Fixture provider", auth: [] });
    api.registerAgentHarness({
      id: ${JSON.stringify(pluginId)}, label: "Fixture harness", authBootstrap: "harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async () => { throw new Error("Only side questions may run"); },
      async runSideQuestion() {
        try {
          bridge.requestSignal.current = bridge.getRequestSignal();
          const observeAbort = () => {
            bridge.abortRegistry.current = bridge.getRegistry();
            bridge.abortObserved.resolve();
          };
          bridge.requestSignal.current?.addEventListener("abort", observeAbort, { once: true });
          if (bridge.requestSignal.current?.aborted) observeAbort();
          bridge.entered.resolve();
          await bridge.finish.promise;
          return { text: String(database.prepare("SELECT value FROM answer").get().value) };
        } finally {
          bridge.cleanupEntered.resolve();
          await bridge.cleanupFinish.promise;
          database.prepare("SELECT value FROM answer").get();
        }
      },
    });
  },
};
`,
        );
        const config: OpenClawConfig = {
          agents: {
            entries: { main: {} },
            defaults: {
              model: { primary: `${pluginId}/model` },
              workspace: state.workspaceDir,
              models: { [`${pluginId}/model`]: { agentRuntime: { id: pluginId } } },
            },
          },
          models: {
            providers: {
              [pluginId]: fixtureProvider("Fixture model", "synthetic-btw-fixture"),
            },
          },
          plugins: {
            load: { paths: [pluginRoot] },
            slots: { memory: "none" },
            entries: { [pluginId]: { enabled: true } },
          },
        };
        const input = {
          config,
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          readOnly: true,
          loadRuntimePlugins: true,
          skipCredentials: true,
          runtimePluginSelections: [{ provider: pluginId, modelId: "model", agentId: "main" }],
        };
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearPluginMetadataLifecycleCaches();
        let first: PreparedModelRuntimeLease | undefined;
        let replacement: PreparedModelRuntimeLease | undefined;
        const owner = new AsyncWorkScope();
        const acquisitionEntered = createDeferredCore();
        const acquisitionFinish = createDeferredCore();
        const cancellationReason = new Error("BTW parent closed");
        let sideQuestion: ReturnType<typeof runBtwSideQuestion> | undefined;
        try {
          first = await acquireReadOnlyPreparedModelRuntime(input, { catalogMode: "static" });
          const original = expectDefined(connections[0], "original provider registration");
          selectedSource.input = input;
          if (mode === "BTW parent close during acquisition") {
            selectedSource.acquisition = {
              entered: acquisitionEntered.resolve,
              completion: acquisitionFinish.promise,
            };
          }
          sideQuestion = owner.track(() =>
            runBtwSideQuestion({
              cfg: config,
              agentId: "main",
              agentDir: input.agentDir,
              provider: pluginId,
              model: "model",
              question: "What is the answer?",
              sessionEntry: {
                sessionId: "btw-native-fixture",
                updatedAt: 1,
                agentHarnessId: pluginId,
              },
              sessionKey: "agent:main:btw-native-fixture",
              isNewSession: false,
              resolvedThinkLevel: "off",
              resolvedReasoningLevel: "off",
            }),
          );
          if (mode === "BTW parent close during acquisition") {
            await Promise.race([
              acquisitionEntered.promise,
              sideQuestion.then(() => {
                throw new Error("BTW did not enter acquisition");
              }),
            ]);
            owner.beginClose(cancellationReason);
            expect(original.disposals).toBe(0);
            acquisitionFinish.resolve();
          }
          await Promise.race([
            bridge.entered.promise,
            sideQuestion.then(() => {
              throw new Error("BTW did not enter the acquired harness");
            }),
          ]);
          if (mode === "BTW parent close") {
            owner.beginClose(cancellationReason);
          }
          expect(bridge.requestSignal.current?.aborted).toBe(true);
          expect(bridge.requestSignal.current?.reason).toBe(cancellationReason);
          await first[Symbol.asyncDispose]();
          expect(original.database.isOpen).toBe(true);
          replacement = await acquireReadOnlyPreparedModelRuntime(input, {
            catalogMode: "static",
          });
          const successor = expectDefined(connections[1], "replacement provider registration");
          bridge.finish.resolve();
          await bridge.cleanupEntered.promise;
          expect(original.database.isOpen).toBe(true);
          bridge.cleanupFinish.resolve();
          expect(await sideQuestion).toEqual({ text: "42" });
          await bridge.abortObserved.promise;
          expect(bridge.abortRegistry.current === first.snapshot.pluginRegistry).toBe(true);
          await owner.drain();
          await expect.poll(() => original.disposals).toBe(1);
          expect(original.database.isOpen).toBe(false);
          expect(successor.database.isOpen).toBe(true);
          await replacement[Symbol.asyncDispose]();
          await expect.poll(() => successor.disposals).toBe(1);
        } finally {
          acquisitionFinish.resolve();
          bridge.finish.resolve();
          bridge.cleanupFinish.resolve();
          await Promise.allSettled([sideQuestion, owner.drain()]);
          selectedSource.input = undefined;
          selectedSource.acquisition = undefined;
          await Promise.allSettled([
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
  },
);

const engineId = "stale-owner-engine";
const providerId = "stale-owner-provider";
type Retention = "gateway" | "direct";

// Off-chain provider selection acquires an inspection borrowing the full-only Gateway engine.
async function withStaleResourceFixture(
  retention: Retention,
  run: (fixture: {
    donor: PluginInstanceHandle;
    acquire: (agentId?: string) => Promise<PreparedModelRuntimeLease>;
    useEngine: (lease: PreparedModelRuntimeLease) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "stale-runtime-resources",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const pluginPaths = [engineId, providerId].map((id) => {
        const rootDir = state.path(id);
        const fixture = runtimeFixture(rootDir, id, {
          providers: id === providerId ? [providerId] : [],
        });
        fs.writeFileSync(
          fixture.runtimeSource,
          id === engineId
            ? `module.exports = { id: ${JSON.stringify(id)}, register(api) {
              if (api.registrationMode !== "full") return;
              api.registerContextEngine(${JSON.stringify(id)}, () => ({
                info: { id: ${JSON.stringify(id)}, name: "Retained donor" },
                ingest: async () => ({ ingested: false }),
                assemble: async ({ messages }) => ({ messages, estimatedTokens: 0,
                  systemPromptAddition: "live donor" }),
                compact: async () => ({ ok: true, compacted: false }),
                dispose: async () => {},
              }));
            } };`
            : `module.exports = { id: ${JSON.stringify(id)}, register(api) {
              api.registerProvider({ id: ${JSON.stringify(id)}, label: "Selected provider", auth: [] });
            } };`,
        );
        return rootDir;
      });
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {}, sibling: {} },
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "base/model" },
            models: { "base/model": {}, [`${providerId}/model`]: {} },
          },
        },
        models: {
          mode: "replace",
          providers: { base: fixtureProvider(), [providerId]: fixtureProvider() },
        },
        plugins: {
          allow: [engineId, providerId],
          load: { paths: pluginPaths },
          entries: { [engineId]: { enabled: true }, [providerId]: { enabled: true } },
          slots: { memory: "none", contextEngine: engineId },
        },
      };
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearPluginMetadataLifecycleCaches();
      try {
        await using leases = new AsyncDisposableStack();
        const root = await loadAndActivateRootPluginRegistry({
          config,
          cache: false,
          onlyPluginIds: [engineId],
          workspaceDir: state.workspaceDir,
        });
        const record = expectDefined(
          root.plugins.find((plugin) => plugin.id === engineId),
          "Gateway context engine record",
        );
        const donor = expectDefined(getPluginInstance(record), "Gateway context engine instance");
        if (retention === "gateway") {
          await refreshPreparedModelRuntimeSnapshots(config, {
            gatewayLifecycle: true,
            catalogMode: "static",
          });
        }
        await run({
          donor,
          acquire: async (agentId = "main") => {
            return leases.use(
              await acquireAgentRunPreparedModelRuntime(
                {
                  config,
                  agentId,
                  agentDir: state.agentDir(agentId),
                  workspaceDir: state.workspaceDir,
                  runtimePluginSelections: [{ provider: providerId, modelId: "model", agentId }],
                },
                { retainIdleRunOwner: retention === "direct" },
              ),
            );
          },
          useEngine: async (lease) => {
            const sessionId = "stale-resources-session";
            const engine = await withPluginRuntimeRegistryScope(
              expectDefined(lease.snapshot.pluginRegistry, "selected run registry"),
              () =>
                createContextEngineLogicalTurnLease({
                  identity: {
                    runId: "stale-resources-turn",
                    sessionId,
                  },
                  config,
                  workspaceDir: state.workspaceDir,
                }),
            );
            await using _ = { [Symbol.asyncDispose]: () => engine.dispose() };
            expect(engine.degraded).toBe(false);
            await expect(
              engine.begin().engine.assemble({ sessionId, messages: [] }),
            ).resolves.toMatchObject({
              systemPromptAddition: "live donor",
            });
          },
        });
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await clearActivePluginRegistry();
        resetPluginLoaderTestStateForTest();
        cleanupPluginLoaderFixturesForTest();
        clearPluginMetadataLifecycleCaches();
      }
    },
  );
}

it.each(["direct", "gateway"] as const)(
  "releases stale %s publication consumers after the last active lease",
  async (retention) => {
    await withStaleResourceFixture(retention, async ({ acquire, donor, useEngine }) => {
      const lease = await acquire();
      if (retention === "direct") {
        await useEngine(lease);
        await lease[Symbol.asyncDispose]();
        expect(donor.hasRetainedConsumers).toBe(true);
      }
      markPreparedModelRuntimeSnapshotsStale("plugin replacement", { waitForReplacement: true });
      let draining: ReturnType<typeof donor.drain> | undefined;
      if (retention === "gateway") {
        draining = donor.drain({ includeConsumers: true });
        const drained = observeSettlement(draining);
        await nextTurn();
        expect(drained()).toBe(false);
        expect(donor.hasRetainedConsumers).toBe(true);
        await useEngine(lease);
        await lease[Symbol.asyncDispose]();
      }
      await expect.poll(() => donor.hasRetainedConsumers).toBe(false);
      await expect(draining ?? donor.drain({ includeConsumers: true })).resolves.toMatchObject({
        errors: [],
      });
    });
  },
);

it("preserves an unaffected agent's retained resources until that scope becomes stale", async () => {
  await withStaleResourceFixture("gateway", async ({ acquire, donor, useEngine }) => {
    const main = await acquire();
    const sibling = await acquire("sibling");
    await main[Symbol.asyncDispose]();
    await sibling[Symbol.asyncDispose]();
    markPreparedModelRuntimeSnapshotsStale("main agent refresh", { agentIds: new Set(["main"]) });
    await nextTurn();

    expect(donor.hasRetainedConsumers).toBe(true);
    const retained = await acquire("sibling");
    expect(retained.snapshot).toBe(sibling.snapshot);
    await useEngine(retained);
    await retained[Symbol.asyncDispose]();
    markPreparedModelRuntimeSnapshotsStale("sibling agent refresh", {
      agentIds: new Set(["sibling"]),
    });

    await expect.poll(() => donor.hasRetainedConsumers).toBe(false);
    await expect(donor.drain({ includeConsumers: true })).resolves.toMatchObject({ errors: [] });
  });
});
