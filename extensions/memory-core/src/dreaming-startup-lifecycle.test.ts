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

describe("dreaming startup lifecycle", () => {
  it("finishes the replacement hook before slow cleanup and still joins cleanup at service stop", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    scrub.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const plugin = await createStartedPlugin();
    const result = plugin.start().then(
      () => "started",
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBe("started");
      let stopped = false;
      const stopping = Promise.resolve(plugin.stop()).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
      // Disposal fences the next agent and deferred sweep, without abandoning admitted work.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(scrub).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await result;
      await plugin.dispose();
    }
  });

  it("reports cleanup rejection after the start hook has completed", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    scrub.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("cleanup storage unavailable");
    });
    const plugin = await createStartedPlugin();
    const starting = plugin.start();
    try {
      await entered.promise;
      await starting;
      release.resolve();
      await plugin.stop();
      expect(plugin.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "dreaming startup cleanup failed for agent main: cleanup storage unavailable",
        ),
      );
    } finally {
      release.resolve();
      await starting;
      await plugin.dispose();
    }
  });

  it("prevents a retired instance from cleaning another agent before its successor starts", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    scrub.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const successorFinished = Promise.withResolvers<void>();
    scrub.mockImplementation(async ({ agentId }) => {
      if (agentId === "researcher") {
        successorFinished.resolve();
      }
    });
    const plugin = await createStartedPlugin();
    const starting = plugin.start();
    try {
      await entered.promise;
      await starting;
      const stopping = plugin.stop();
      release.resolve();
      await stopping;
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
    } finally {
      release.resolve();
      await starting;
      await plugin.dispose();
    }
  });
});
