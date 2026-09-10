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
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { runBtwSideQuestion } from "./btw.js";
import {
  acquirePublishedPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const selectedSource = vi.hoisted(() => {
  const state: { input?: PreparedModelRuntimeInput } = {};
  return state;
});

// Exercise BTW against an already-owned source without enabling configured producer disposal.
vi.mock("./prepared-model-runtime.js", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("./prepared-model-runtime.js")>();
  return {
    ...runtime,
    loadPreparedModelRuntimeSnapshot: (
      input: Parameters<typeof runtime.loadPreparedModelRuntimeSnapshot>[0],
    ) => runtime.loadPreparedModelRuntimeSnapshot(selectedSource.input ?? input),
    acquirePublishedPreparedModelRuntime: (
      input: Parameters<typeof runtime.acquirePublishedPreparedModelRuntime>[0],
    ) => runtime.acquirePublishedPreparedModelRuntime(selectedSource.input ?? input),
  };
});

it.each(["published borrow", "BTW harness cleanup", "BTW parent close"] as const)(
  "retains an acquired SQLite source through %s and replacement",
  async (mode) => {
    await withOpenClawTestState({ label: "published-runtime-resources" }, async (state) => {
      const pluginId = "published-runtime-provider";
      const pluginRoot = state.path("plugin");
      const emptyBundled = state.path("empty-bundled");
      fs.mkdirSync(pluginRoot);
      fs.mkdirSync(emptyBundled);
      const fixture = createColdPluginFixture({
        rootDir: pluginRoot,
        pluginId,
        providerId: pluginId,
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
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
      });
      const key = `__published_runtime_resources_${path.basename(state.root)}`;
      const connections: Array<{ file: string; database: DatabaseSync; disposals: number }> = [];
      const requestSignal: { current?: AbortSignal } = {};
      const abortRegistry: { current?: ReturnType<typeof getPluginRuntimeGenerationRegistry> } = {};
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
    const connection = { file, database, disposals: 0 };
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
          bridge.requestSignal.current?.addEventListener("abort", () => {
            bridge.abortRegistry.current = bridge.getRegistry();
            bridge.abortObserved.resolve();
          }, { once: true });
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
          defaults: {
            model: { primary: `${pluginId}/model` },
            workspace: state.workspaceDir,
            agentRuntime: { id: pluginId },
          },
        },
        models: {
          providers: {
            [pluginId]: {
              api: "openai-completions",
              apiKey: "synthetic-btw-fixture",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                {
                  id: "model",
                  name: "Fixture model",
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
      await withEnvAsync(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: emptyBundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          let first: Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>> | undefined;
          let borrower:
            | Awaited<ReturnType<typeof acquirePublishedPreparedModelRuntime>>
            | undefined;
          let replacement:
            | Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>>
            | undefined;
          const owner = new AsyncWorkScope();
          let sideQuestion: ReturnType<typeof runBtwSideQuestion> | undefined;
          try {
            first = await acquireReadOnlyPreparedModelRuntime(input, undefined, "static");
            expect(connections).toHaveLength(1);
            const original = expectDefined(connections[0], "original provider registration");
            if (mode === "published borrow") {
              const pending = acquirePublishedPreparedModelRuntime(input);
              first.release();
              borrower = await pending;
              expect(borrower.snapshot).toBe(first.snapshot);
            } else {
              selectedSource.input = input;
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
              await Promise.race([
                bridge.entered.promise,
                sideQuestion.then(() => {
                  throw new Error("BTW did not enter the acquired harness");
                }),
              ]);
              if (mode === "BTW parent close") {
                const reason = new Error("BTW parent closed");
                owner.beginClose(reason);
                expect(bridge.requestSignal.current?.aborted).toBe(true);
                expect(bridge.requestSignal.current?.reason).toBe(reason);
              }
              first.release();
            }
            expect(original.database.isOpen).toBe(true);
            replacement = await acquireReadOnlyPreparedModelRuntime(input, undefined, "static");
            expect(connections).toHaveLength(2);
            const successor = expectDefined(connections[1], "replacement provider registration");
            expect(original.database.prepare("SELECT value FROM answer").get()?.value).toBe(42);
            if (mode !== "published borrow") {
              bridge.finish.resolve();
              await bridge.cleanupEntered.promise;
              expect(original.database.isOpen).toBe(true);
              bridge.cleanupFinish.resolve();
              expect(await sideQuestion).toEqual({ text: "42" });
              await bridge.abortObserved.promise;
              expect(bridge.abortRegistry.current === first.snapshot.pluginRegistry).toBe(true);
              await owner.drain();
            } else {
              borrower?.release();
            }
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
            bridge.finish.resolve();
            bridge.cleanupFinish.resolve();
            await Promise.allSettled([sideQuestion, owner.drain()]);
            selectedSource.input = undefined;
            first?.release();
            borrower?.release();
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
