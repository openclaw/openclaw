import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  preparedModelRuntime,
  registerIsolatedHarness,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

// Keep inference/auth synthetic; exercise the real entrypoint's registry plan and loader.
const { prepareWorkspacePluginRegistries, preparedModelRuntimeWorkspaceFactsKey } =
  await import("./prepared-model-runtime.inbound-registry.js");
const { ownerKey, hasSameLifecycleInput } = await import("./prepared-model-runtime.owner.js");
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

beforeEach(resetIsolatedCompletionTestState);
afterEach(async () => {
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, contextEvaluation);
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("completes without loading configured context/memory or unrelated startup plugins", async () => {
  useNoBundledPlugins();
  const engine = writePlugin({
    id: "expensive-engine",
    body: `globalThis[Symbol.for("openclaw.test.isolatedContextEvaluation")] = true;
      throw new Error("Prompt-only inference must not load the configured engine");`,
  });
  // Large configured packages must stay outside capture, regardless of their contents.
  writeFileSync(path.join(engine.dir, "unused-runtime-data.bin"), Buffer.alloc(1024 * 1024));
  const memory = writePlugin({
    id: "expensive-memory",
    body: `globalThis[Symbol.for("openclaw.test.isolatedContextEvaluation")] = true;
      throw new Error("Prompt-only inference must not load the configured memory plugin");`,
  });
  writeFileSync(
    path.join(memory.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: memory.id, kind: "memory", configSchema: { type: "object" } }),
  );
  const provider = writePlugin({
    id: "openai",
    registration: 'api.registerProvider({ id: "openai", label: "Fixture", auth: [] });',
  });
  writeFileSync(
    path.join(provider.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: "openai", providers: ["openai"], configSchema: { type: "object" } }),
  );
  const harness = writePlugin({
    id: "codex",
    registration: `api.registerAgentHarness({ id: "codex", label: "Fixture",
      supports: () => ({ supported: true }), runAttempt: async () => {} });`,
  });
  writeFileSync(
    path.join(harness.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "codex",
      activation: { onAgentHarnesses: ["codex"] },
      configSchema: { type: "object" },
    }),
  );
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
        ...preparedModelRuntime,
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
  registerIsolatedHarness({
    runIsolatedCompletionV2: vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "Gateway log rotation" }]),
    })),
  });
  await expect(runIsolatedCompletion({ ...isolatedRequest(), config })).resolves.toMatchObject({
    text: "Gateway log rotation",
  });
  expect(Reflect.get(globalThis, contextEvaluation)).toBeUndefined();
});

it("keeps isolated registry preparation distinct from an ordinary agent publication", () => {
  const input: PreparedModelRuntimeInput = { config: {}, agentDir: "/fixture/agent" };
  const isolated: PreparedModelRuntimeInput = {
    ...input,
    runtimePluginPurpose: "isolated-completion",
  };
  expect(ownerKey(input)).not.toBe(ownerKey(isolated));
  expect(preparedModelRuntimeWorkspaceFactsKey(input)).not.toBe(
    preparedModelRuntimeWorkspaceFactsKey(isolated),
  );
  expect(hasSameLifecycleInput(input, isolated)).toBe(false);
});

it.each(["cli", "harness"] as const)("reports the %s owner the run dispatches to", async (kind) => {
  const cli = kind === "cli";
  mocks.resolveEmbeddedCliBackendDispatchEligibility.mockReturnValue(
    cli ? { provider: "claude-cli" } : undefined,
  );
  mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "Utility result" }] });
  registerIsolatedHarness({
    runIsolatedCompletionV2: vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "done" }]),
    })),
  });
  const request = cli
    ? {
        ...isolatedRequest(),
        provider: "anthropic",
        model: "claude-test",
        agentHarnessRuntimeOverride: undefined,
      }
    : isolatedRequest();
  const status = await resolveIsolatedCompletionRuntime(request);
  const run = await runIsolatedCompletion(request);
  expect(run.owner).toEqual({ kind, id: cli ? "claude-cli" : "codex" });
  expect(status).toEqual({ id: run.owner.id, kind, ...(cli ? {} : { harnessLabel: "Codex" }) });
});
