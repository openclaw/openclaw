import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createHookRunner,
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

const scrub = vi.hoisted(() =>
  vi.fn<typeof import("./dreaming-session-cleanup.js").scrubDreamingNarrativeArtifacts>(),
);
// mock-isolation: Hold cleanup I/O without touching agent storage; storage effects have their own suite.
vi.mock("./dreaming-session-cleanup.js", () => ({
  DREAMING_ORPHAN_MIN_AGE_MS: 300_000,
  scrubDreamingNarrativeArtifacts: scrub,
}));

beforeEach(() => {
  vi.useFakeTimers();
  scrub.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

async function createStartedPlugin() {
  const config: OpenClawConfig = {
    agents: {
      entries: {
        main: { workspace: "/synthetic/main" },
        researcher: { workspace: "/synthetic/researcher" },
      },
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const builder = createPluginRegistry({
    logger,
    runtime: createPluginRuntimeMock({ config: { current: () => config } }),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "memory-core", origin: "bundled", kind: "memory" });
  builder.registry.plugins.push(record);
  registerShortTermPromotionDreaming(builder.createApi(record, { config }));
  const service = builder.registry.services.find(
    (entry) => entry.id === "memory-core-dreaming",
  )?.service;
  if (!service || !("start" in service)) {
    throw new Error("Expected the dreaming service");
  }
  const scheduler = createTestPluginServiceScheduler();
  const context = { config, stateDir: "/synthetic", logger, getCron: () => undefined, scheduler };
  await service.start(context);
  // Match the real hot-replacement owner: errors propagate, and each start hook has 5 seconds.
  const hooks = createHookRunner(builder.registry, {
    logger,
    catchErrors: false,
    voidHookTimeoutMsByHook: { gateway_start: 5_000 },
  });
  return {
    logger,
    start: () => hooks.runGatewayStart({ port: 0 }, context),
    stop: () => service.stop?.(context),
    async dispose() {
      await service.stop?.(context);
      await scheduler.stop();
      await disposePluginRegistryInstances(builder.registry, undefined, { cfg: config });
    },
  };
}

async function withBlockedCleanup(
  check: (
    plugin: Awaited<ReturnType<typeof createStartedPlugin>>,
    starting: Promise<void>,
    release: () => void,
  ) => Promise<void>,
  failure?: Error,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  scrub.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    if (failure) {
      throw failure;
    }
  });
  const plugin = await createStartedPlugin();
  const starting = plugin.start();
  try {
    await entered.promise;
    await check(plugin, starting, release.resolve);
  } finally {
    release.resolve();
    await starting;
    await plugin.dispose();
  }
}

describe("dreaming startup lifecycle", () => {
  it("reports cleanup rejection after the start hook has completed", () =>
    withBlockedCleanup(async (plugin, starting, release) => {
      await starting;
      release();
      await plugin.stop();
      expect(plugin.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "dreaming startup cleanup failed for agent main: cleanup storage unavailable",
        ),
      );
    }, new Error("cleanup storage unavailable")));

  it("starts promptly, drains admitted cleanup, then fences the retired instance before replacement", async () => {
    const successorFinished = Promise.withResolvers<void>();
    scrub.mockImplementation(async ({ agentId }) => {
      if (agentId === "researcher") {
        successorFinished.resolve();
      }
    });
    await withBlockedCleanup(async (plugin, starting, release) => {
      const result = starting.then(
        () => "started",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBe("started");
      const stopped = vi.fn();
      const stopping = Promise.resolve(plugin.stop()).then(stopped);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(stopped).toHaveBeenCalledOnce();
      expect(scrub).toHaveBeenCalledTimes(1);
      const successor = await createStartedPlugin();
      try {
        await successor.start();
        await successorFinished.promise;
        await successor.stop();
      } finally {
        await successor.dispose();
      }
      // One admitted retired-instance scrub plus the successor's two agents.
      expect(scrub).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(scrub).toHaveBeenCalledTimes(3);
    });
  });
});
