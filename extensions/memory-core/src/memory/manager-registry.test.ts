// Memory Core tests cover manager registry behavior.
import path from "node:path";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRuntime } from "../runtime-provider.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import {
  closeAllMemoryIndexManagers,
  closeMemoryIndexManagersForAgent,
} from "./manager-runtime.js";
import { MemoryIndexManager as RuntimeMemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, requireManager, trackManager } = fixture;

  const request = (
    cfg: ReturnType<typeof createCfg>,
    options: Partial<Parameters<typeof getMemorySearchManager>[0]> = {},
  ) =>
    getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
      ...options,
    });
  const acquire = async (
    cfg: ReturnType<typeof createCfg>,
    options: Partial<Parameters<typeof getMemorySearchManager>[0]> = {},
  ) => {
    const manager = requireManager(await request(cfg, options));
    trackManager(manager);
    return manager;
  };
  const initialized = async (cfg: ReturnType<typeof createCfg>) => {
    const manager = await acquire(cfg);
    await manager.probeEmbeddingAvailability();
    return manager;
  };
  function holdProviderClose() {
    const gate = Promise.withResolvers<void>();
    providerFixture.providerCloseGate = gate.promise;
    return () => {
      gate.resolve();
      providerFixture.providerCloseGate = null;
    };
  }

  it("waits for scoped manager close before initializing a replacement", async () => {
    const releaseProviderClose = holdProviderClose();
    const cfg = createCfg({});
    const first = await initialized(cfg);
    const closePromise = closeMemoryIndexManagersForAgent({ agentId: "main" });
    const callsBeforeReplacement = providerFixture.providerCalls.length;
    const secondPromise = acquire(cfg);
    const concurrentSecondPromise = acquire(cfg);
    const secondProbe = secondPromise.then(async (manager) => {
      await manager.probeEmbeddingAvailability();
    });
    const secondSettled = vi.fn();
    void secondPromise.then(secondSettled, secondSettled);
    try {
      await vi.waitFor(() => {
        expect(providerFixture.providerCloseCalls).toBe(1);
      });
      await Promise.resolve();
      expect(secondSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
    }
    await closePromise;
    const second = await secondPromise;
    const concurrentSecond = await concurrentSecondPromise;
    await secondProbe;
    expect(second === first).toBe(false);
    expect(concurrentSecond).toBe(second);

    const third = await acquire(cfg);
    expect(third).toBe(second);
  });

  it("does not reuse a cached manager after direct close starts", async () => {
    const releaseProviderClose = holdProviderClose();
    const cfg = createCfg({});
    const first = await initialized(cfg);

    const closePromise = first.close();
    const replacementPromise = acquire(cfg);
    const replacementSettled = vi.fn();
    void replacementPromise.then(replacementSettled, replacementSettled);
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
      await Promise.resolve();
      expect(replacementSettled).not.toHaveBeenCalled();
    } finally {
      releaseProviderClose();
    }

    await closePromise;
    const replacement = await replacementPromise;
    expect(replacement === first).toBe(false);
  });

  it("serializes concurrent acquisitions with different cache identities", async () => {
    const firstCfg = createCfg({ model: "first-model" });
    const first = await initialized(firstCfg);
    const releaseProviderClose = holdProviderClose();

    const secondPromise = acquire(createCfg({ model: "second-model" }));
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
    const thirdPromise = acquire(createCfg({ model: "third-model" }));
    try {
      await Promise.resolve();
      expect(providerFixture.providerCalls).toHaveLength(1);
    } finally {
      releaseProviderClose();
    }

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    expect(second === first).toBe(false);
    expect(third === second).toBe(false);
    expect((second as unknown as { closed: boolean }).closed).toBe(true);
    expect((third as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("separates cached query configuration without re-embedding unchanged documents", async () => {
    const cfg = createCfg({ minScore: 0 });
    const first = await acquire(cfg);
    await first.sync({ reason: "test" });
    await first.search("alpha");
    const batchCalls = providerFixture.embedBatchCalls;
    const changed = {
      ...cfg,
      memory: {
        ...cfg.memory,
        search: { ...cfg.memory?.search, queryInstruction: "search_query: " },
      },
    };
    const second = await acquire(changed);
    expect(second).not.toBe(first);
    expect(await second.search("alpha")).not.toEqual([]);
    await (second as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    expect(providerFixture.embeddedQueryTexts).toContain("search_query: alpha");
    expect(providerFixture.embedBatchCalls).toBe(batchCalls);
    expect(await acquire(changed)).toBe(second);
  });

  it("canonicalizes agent ids before builtin manager acquisition", async () => {
    const cfg = createCfg({ model: "canonical-model" });
    const first = await RuntimeMemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "Main-Agent",
    });
    const second = await RuntimeMemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main-agent",
    });
    if (!first || !second) {
      throw new Error("Expected canonical memory index managers");
    }
    trackManager(first);
    trackManager(second);
    expect(second).toBe(first);
  });

  it("retires the prior builtin manager when an agent workspace changes", async () => {
    const firstCfg = createCfg({ model: "workspace-model" });
    const secondCfg = createCfg({ model: "workspace-model" });
    if (!firstCfg.agents?.defaults || !secondCfg.agents?.defaults) {
      throw new Error("Expected agent defaults");
    }
    firstCfg.agents.defaults.workspace = path.join(fixture.paths.root, "workspace-a");
    secondCfg.agents.defaults.workspace = path.join(fixture.paths.root, "workspace-b");

    const first = await RuntimeMemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: firstCfg,
      agentId: "main",
    });
    const second = await RuntimeMemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: secondCfg,
      agentId: "main",
    });
    if (!first || !second) {
      throw new Error("Expected workspace memory index managers");
    }
    trackManager(first);
    trackManager(second);
    expect(second === first).toBe(false);
    expect((first as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("does not block another agent while one scope retires its manager", async ({ signal }) => {
    const firstCfg = createCfg({ model: "first-model" });
    await initialized(firstCfg);
    const releaseProviderClose = holdProviderClose();

    const replacementPromise = request(createCfg({ model: "second-model" }));
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
    const otherAgentPromise = request(createCfg({ model: "other-model" }), { agentId: "other" });
    try {
      const otherAgent = requireManager(await withinTest(otherAgentPromise, signal));
      trackManager(otherAgent);
      expect((otherAgent as unknown as { closed: boolean }).closed).toBe(false);
    } finally {
      releaseProviderClose();
    }

    const replacement = requireManager(await replacementPromise);
    trackManager(replacement);
  });

  it("global teardown waits for an admitted builtin manager replacement", async () => {
    const first = await RuntimeMemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: createCfg({ model: "first-model" }),
      agentId: "main",
    });
    if (!first) {
      throw new Error("Expected first memory index manager");
    }
    trackManager(first);
    await first.probeEmbeddingAvailability();
    const releaseProviderClose = holdProviderClose();

    const replacementPromise = RuntimeMemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    });
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
    const globalClosePromise = closeAllMemoryIndexManagers();
    const globalCloseSettled = vi.fn();
    void globalClosePromise.then(globalCloseSettled, globalCloseSettled);
    try {
      await Promise.resolve();
      expect(globalCloseSettled).not.toHaveBeenCalled();
    } finally {
      releaseProviderClose();
    }

    const replacement = await replacementPromise;
    await globalClosePromise;
    if (!replacement) {
      throw new Error("Expected replacement memory index manager");
    }
    trackManager(replacement);
    expect((replacement as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("declines a maintenance manager that arrives during global teardown", async () => {
    const cfg = createCfg({});
    await initialized(cfg);
    const releaseProviderClose = holdProviderClose();

    const globalClose = closeAllMemoryIndexManagers();
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
      await expect(
        RuntimeMemoryIndexManager.get({
          runInBackgroundContext: runInMemoryTestBackgroundContext,
          cfg,
          agentId: "main",
          purpose: "maintenance",
        }),
      ).resolves.toBeNull();
    } finally {
      releaseProviderClose();
    }
    await globalClose;
  });

  it("retains failed reload retirement through healthy acquisition and final close", async () => {
    const cfg = createCfg({});
    const first = await initialized(cfg);
    providerFixture.providerCloseFailuresRemaining = 1;
    const retirement = createMemoryRuntime({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
    }).prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
    try {
      await expect(retirement.drain()).resolves.toEqual({
        errors: [expect.objectContaining({ message: "provider close failed" })],
      });
      expect(providerFixture.providerCloseCalls).toBe(1);
    } finally {
      retirement.resume();
    }

    const replacement = await acquire(cfg);
    expect(replacement).not.toBe(first);
    expect(providerFixture.providerCloseCalls).toBe(1);
    await replacement.probeEmbeddingAvailability();
    expect(await acquire(cfg)).toBe(replacement);

    await closeAllMemoryIndexManagers();
    expect(providerFixture.providerCloseCalls).toBe(3);
    await closeAllMemoryIndexManagers();
    expect(providerFixture.providerCloseCalls).toBe(3);
  });

  it("retains a failed scoped close owner until provider retirement succeeds", async () => {
    const cfg = createCfg({});
    const first = await initialized(cfg);
    providerFixture.providerCloseFailuresRemaining = 1;

    await expect(closeMemoryIndexManagersForAgent({ agentId: "main" })).rejects.toThrow(
      "provider close failed",
    );
    expect(providerFixture.providerCloseCalls).toBe(1);

    const releaseProviderClose = holdProviderClose();
    const callsBeforeReplacement = providerFixture.providerCalls.length;
    const replacementPromise = acquire(cfg);
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(2));
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
    }

    const replacement = await replacementPromise;
    trackManager(replacement);
    expect(replacement === first).toBe(false);
  });

  it("reports failed global cleanup until an explicit close succeeds", async () => {
    const cfg = createCfg({});
    const first = await initialized(cfg);
    providerFixture.providerCloseFailuresRemaining = 1;
    providerFixture.providerCloseFailure = undefined;

    let globalCloseRejected = false;
    await closeAllMemorySearchManagers().then(
      () => {},
      () => {
        globalCloseRejected = true;
      },
    );
    expect(globalCloseRejected).toBe(true);
    expect(providerFixture.providerCloseCalls).toBe(1);

    const unavailable = await request(cfg);
    expect(unavailable.manager).toBeNull();
    expect(unavailable.error).toContain("Embedding provider retirement failed");

    const releaseProviderClose = holdProviderClose();
    const callsBeforeReplacement = providerFixture.providerCalls.length;
    const retryGlobalClose = closeAllMemorySearchManagers();
    const replacementPromise = acquire(cfg);
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(2));
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
    }

    const replacement = await replacementPromise;
    await retryGlobalClose;
    expect(replacement === first).toBe(false);
    expect((replacement as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("does not reuse memory index managers across local-service hosts", async () => {
    const cfg = createCfg({});
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);
    const first = await acquire(cfg, { acquireLocalService: firstAcquire });

    const second = await acquire(cfg, { acquireLocalService: secondAcquire });
    const secondAgain = await acquire(cfg, { acquireLocalService: secondAcquire });

    expect(Object.is(second, first)).toBe(false);
    expect(Object.is(secondAgain, second)).toBe(true);
  });

  it("retains failed embedding provider close for the next explicit close", async () => {
    providerFixture.providerCloseFailuresRemaining = 1;
    const cfg = createCfg({});
    const manager = await getFreshManager(cfg);

    await manager.probeEmbeddingAvailability();
    await expect(manager.close()).rejects.toThrow("provider close failed");
    expect(providerFixture.providerCloseCalls).toBe(1);
    await manager.close();

    expect(providerFixture.providerCloseCalls).toBe(2);
  });
});
