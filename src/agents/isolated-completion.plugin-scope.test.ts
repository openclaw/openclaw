import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import * as fixtures from "./isolated-completion.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

// Keep inference/auth synthetic; exercise the real entrypoint's registry plan and loader.
const { prepareWorkspacePluginRegistries } =
  await import("./prepared-model-runtime.inbound-registry.js");
const { loadPluginMetadataSnapshot } = await import("../plugins/plugin-metadata-snapshot.js");
const {
  writePlugin,
  useNoBundledPlugins,
  resetPluginLoaderTestStateForTest,
  cleanupPluginLoaderFixturesForTest,
} = await import("../plugins/loader.test-fixtures.js");
const { clearActivePluginRegistry, disposePluginRegistryInstances } =
  await import("../plugins/runtime.js");

const contextEvaluation = Symbol.for("openclaw.test.isolatedContextEvaluation");
const { resolveIsolatedCompletionRuntime } = await import("./isolated-completion-route.js");
const mocks = fixtures.isolatedCompletionMocks;

beforeEach(fixtures.resetIsolatedCompletionTestState);
afterEach(async () => {
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, contextEvaluation);
});
afterAll(cleanupPluginLoaderFixturesForTest);

function writeManifest(plugin: ReturnType<typeof writePlugin>, metadata: object) {
  const manifest = { id: plugin.id, ...metadata, configSchema: { type: "object" } };
  writeFileSync(path.join(plugin.dir, "openclaw.plugin.json"), JSON.stringify(manifest));
}

function unloadedPlugin(id: string) {
  return writePlugin({
    id,
    body: `globalThis[Symbol.for("openclaw.test.isolatedContextEvaluation")] = true;
      throw new Error("Prompt-only inference must not load ${id}");`,
  });
}

function useHarness(text: string) {
  const assistant = fixtures.isolatedAssistant([{ type: "text", text }]);
  fixtures.registerIsolatedHarness({
    runIsolatedCompletionV2: async () => ({ assistant }),
  });
}

it("completes without loading configured context/memory or unrelated startup plugins", async () => {
  useNoBundledPlugins();
  const engine = unloadedPlugin("expensive-engine");
  // Large configured packages must stay outside capture, regardless of their contents.
  writeFileSync(path.join(engine.dir, "unused-runtime-data.bin"), Buffer.alloc(1024 * 1024));
  const memory = unloadedPlugin("expensive-memory");
  writeManifest(memory, { kind: "memory" });
  const provider = writePlugin({
    id: "openai",
    registration: 'api.registerProvider({ id: "openai", label: "Fixture", auth: [] });',
  });
  writeManifest(provider, { providers: ["openai"] });
  const harness = writePlugin({
    id: "codex",
    registration: `api.registerAgentHarness({ id: "codex", label: "Fixture",
      supports: () => ({ supported: true }), runAttempt: async () => {} });`,
  });
  writeManifest(harness, { activation: { onAgentHarnesses: ["codex"] } });
  const config = {
    plugins: {
      allow: [engine.id, memory.id, provider.id, harness.id],
      load: { paths: [engine.file, memory.file, provider.file, harness.file] },
      slots: { contextEngine: engine.id, memory: memory.id },
      entries: { [engine.id]: { enabled: true }, [memory.id]: { enabled: true } },
    },
  };
  const metadata = loadPluginMetadataSnapshot({ config, workspaceDir: provider.dir });
  mocks.acquireAgentRunPreparedModelRuntime.mockImplementationOnce(async (input, options) => {
    const preparedInput: PreparedModelRuntimeInput = {
      ...input,
      workspaceDir: provider.dir,
      runtimePluginSelections: options.deriveRuntimePluginSelections({
        config,
        metadataSnapshot: metadata,
      }),
    };
    const { runtimePluginRegistry: registry } = await prepareWorkspacePluginRegistries(
      preparedInput,
      metadata,
      () => {},
    );
    expect(
      registry?.plugins
        .filter((record) => record.status === "loaded")
        .map((record) => record.id)
        .toSorted(),
    ).toEqual(["codex", "openai"]);
    expect(registry?.contextEngines.size).toBe(0);
    return {
      snapshot: {
        ...fixtures.preparedModelRuntime,
        config,
        metadataSnapshot: metadata,
        pluginRegistry: registry,
      },
      [Symbol.asyncDispose]: async () => {
        if (registry) {
          await disposePluginRegistryInstances(registry);
        }
      },
    };
  });
  useHarness("Gateway log rotation");
  await expect(
    fixtures.runIsolatedCompletion({ ...fixtures.isolatedRequest(), config }),
  ).resolves.toMatchObject({
    text: "Gateway log rotation",
  });
  expect(Reflect.get(globalThis, contextEvaluation)).toBeUndefined();
});

it("reports the CLI owner the run dispatches to", async () => {
  mocks.resolveEmbeddedCliBackendDispatchEligibility.mockReturnValue({ provider: "claude-cli" });
  mocks.runCliAgent.mockResolvedValue({
    payloads: [{ text: "Utility result" }],
  });
  useHarness("done");
  const request = fixtures.isolatedRequest({
    provider: "anthropic",
    model: "claude-test",
    agentHarnessRuntimeOverride: undefined,
  });
  const status = await resolveIsolatedCompletionRuntime(request);
  const run = await fixtures.runIsolatedCompletion(request);
  expect(run.owner).toEqual({ kind: "cli", id: "claude-cli" });
  expect(status).toEqual({ kind: "cli", id: "claude-cli" });
});
