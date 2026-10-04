// Memory Core background sync resolves plugins from the live registry, not from
// the plugin generation that first loaded the module (#159912).
import { AsyncLocalStorage } from "node:async_hooks";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  createEmptyPluginRegistry,
  getRegisteredEmbeddingProvider,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  withPluginRuntimeGatewayRequestScope,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PluginRegistry = ReturnType<typeof createEmptyPluginRegistry>;

function registryWithProbeOwnedBy(pluginId: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.embeddingProviders.push({
    pluginId,
    provider: { id: "probe" } as PluginRegistry["embeddingProviders"][number]["provider"],
    source: "runtime",
  });
  return registry;
}

// The generation that loads the memory-core modules. A plugin reload or an
// in-process restart retires it while the bundled modules stay loaded.
const loadingGeneration = registryWithProbeOwnedBy("retired-generation");
const liveGeneration = registryWithProbeOwnedBy("live-generation");

// Loaded once, under the loading generation's request scope, the way a
// Gateway first evaluates the plugin entry.
const modules = withPluginRuntimeGatewayRequestScope(
  { isWebchatConnect: () => false, pluginRegistry: loadingGeneration },
  async () => ({
    context: await import("./background-context.js"),
    support: await import("./manager-sync-ops.startup-catchup.test-support.js"),
  }),
);

describe("memory background sync after a plugin generation is retired", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-memory-background-generation-",
      layout: "state-only",
    });
  });

  afterEach(async () => {
    const { support } = await modules;
    support.resetTranscriptUpdateListener();
    for (const database of support.startupHarnessDatabases) {
      await database.closeShadow();
    }
    support.startupHarnessDatabases.clear();
    resetPluginRuntimeStateForTest();
    await testState.restoreEnv();
    await testState.cleanup();
  });

  it("runs the startup catch-up sync against the live registry", async () => {
    const { context, support } = await modules;
    const seenOwners: Array<string | undefined> = [];

    class ObservedHarness extends support.SessionStartupCatchupHarness {
      armBackgroundWork(): void {
        // The composition MemoryIndexManager runs when it opens (manager.ts).
        context.runInMemoryBackgroundContext(() => this.ensureSessionStartupCatchup());
      }

      protected override async sync(params?: MemorySyncParams): Promise<void> {
        seenOwners.push(getRegisteredEmbeddingProvider("probe")?.ownerPluginId);
        await super.sync(params);
      }
    }

    // The reload: a new generation is live; the loading one is retired.
    setActivePluginRegistry(liveGeneration);
    const harness = new ObservedHarness([]);
    harness.markFullSessionRetry();

    harness.armBackgroundWork();

    // The catch-up reaches sync in about 1.1 to 1.3 s on current main, past waitFor's 1 s default.
    await vi.waitFor(() => expect(harness.syncCalls).toHaveLength(1), { timeout: 5_000 });
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(seenOwners).toEqual(["live-generation"]);
  });

  it("still runs outside the turn that schedules the work", async () => {
    const { context } = await modules;
    const turn = new AsyncLocalStorage<string>();

    const observed = turn.run("a turn", () =>
      context.runInMemoryBackgroundContext(() => turn.getStore()),
    );

    expect(observed).toBeUndefined();
  });

  it("passes arguments through and returns the callback's result", async () => {
    const { context } = await modules;

    expect(context.runInMemoryBackgroundContext((a: number, b: number) => a + b, 2, 3)).toBe(5);
  });
});
