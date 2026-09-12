import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { describe, expect, it, vi } from "vitest";
import { prepareMemoryManagerReload, type MemoryManagerLifecycle } from "./lifecycle.js";
import { MemoryManagerRegistry } from "./manager-registry.js";

describe("memory manager adapter retirement", () => {
  it.each(["reject", "unavailable"])(
    "retires a fallback-backed manager when its %s primary adapter is replaced",
    async (failure) => {
      const registry = new MemoryManagerRegistry();
      const manager = { close: vi.fn(async () => {}) };
      const unaffected = { close: vi.fn(async () => {}) };
      registry.track(manager, "fallback-backed");
      registry.track(unaffected, "fallback-only");
      const primary: MemoryEmbeddingProviderAdapter = {
        id: "primary",
        create: async () => ({ provider: null }),
      };
      const fallback: MemoryEmbeddingProviderAdapter = {
        id: "fallback",
        create: async () => ({
          provider: {
            id: "fallback",
            model: "test-embedding",
            embed: async () => [1],
            embedBatch: async () => [[1]],
          },
        }),
      };
      const creation = registry.createProvider(manager, primary, async () => {
        if (failure === "reject") {
          throw new Error("Primary adapter unavailable");
        }
        return { provider: null };
      });
      if (failure === "reject") {
        await expect(creation).rejects.toThrow("Primary adapter unavailable");
      } else {
        await expect(creation).resolves.toEqual({ provider: null });
      }
      for (const owner of [manager, unaffected]) {
        await registry.createProvider(owner, fallback, () =>
          fallback.create({ config: {}, model: "test-embedding" }),
        );
      }

      const retirement = registry.prepareReload({
        retireRuntime: false,
        retiringEmbeddingProviders: [primary],
      });
      try {
        await expect(retirement.drain()).resolves.toEqual({ errors: [] });
        expect(manager.close).toHaveBeenCalledOnce();
        expect(unaffected.close).not.toHaveBeenCalled();
      } finally {
        retirement.resume();
      }
    },
  );
});

it("joins pending manager cleanup across overlapping reload drains", async () => {
  const registry = new MemoryManagerRegistry();
  const closing = createDeferred<void>();
  const manager = { close: () => closing.promise };
  const failure = new Error("manager cleanup failed");
  registry.track(manager, "shared-manager");
  const first = registry.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  const firstDrain = first.drain();
  const second = registry.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  const secondDrain = second.drain();
  try {
    closing.reject(failure);
    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([
      { errors: [failure] },
      { errors: [failure] },
    ]);
  } finally {
    closing.resolve();
    await Promise.allSettled([firstDrain, secondDrain]);
    first.resume();
    second.resume();
  }
});

it("owns failed late creation cleanup until explicit close", async () => {
  const registry = new MemoryManagerRegistry();
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const failure = new Error("late manager close failed");
  const late = { close: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) };
  const replacement = { close: vi.fn(async () => {}) };
  const transient = { close: vi.fn(async () => {}) };
  const pending = registry.acquire(
    { agentId: "main", purpose: "default" },
    {
      prepare: () => ({
        key: "main:late:default",
        reuse: () => true,
        create: async () => {
          entered.resolve();
          await released.promise;
          return late;
        },
      }),
    },
  );
  const observed = expect(pending).rejects.toBe(failure);
  await entered.promise;
  const retirement = registry.prepareReload({
    retireRuntime: true,
    retiringEmbeddingProviders: [],
  });
  const draining = retirement.drain();
  released.resolve();
  try {
    await observed;
    await draining;
  } finally {
    released.resolve();
    retirement.resume();
  }
  expect.soft(registry.canPublishProbe(late)).toBe(false);
  expect(late.close).toHaveBeenCalledOnce();
  await registry.acquire(
    { agentId: "main", purpose: "default" },
    {
      prepare: () => ({ key: "main:late:default", reuse: () => true, create: () => replacement }),
    },
  );
  await registry.acquire(
    { agentId: "main", purpose: "status" },
    {
      prepare: () => ({ key: "main:status", reuse: () => true, create: () => transient }),
    },
  );
  expect(late.close).toHaveBeenCalledOnce();
  await registry.closeAll();
  expect(late.close).toHaveBeenCalledTimes(2);
  expect(replacement.close).toHaveBeenCalledOnce();
  expect(transient.close).not.toHaveBeenCalled();
  await registry.closeAll();
  expect(late.close).toHaveBeenCalledTimes(2);
  expect(replacement.close).toHaveBeenCalledOnce();
  await transient.close();
});

it("fences acquisition when reload starts before the manager owner initializes", async () => {
  const lifecycle: MemoryManagerLifecycle = {};
  const reload = prepareMemoryManagerReload(
    { retireRuntime: true, retiringEmbeddingProviders: [] },
    lifecycle,
  );
  const registry = new MemoryManagerRegistry(lifecycle);
  const manager = { close: vi.fn(async () => {}) };
  const create = vi.fn(() => manager);
  const acquire = () =>
    registry.acquire(
      { agentId: "main", purpose: "default" },
      {
        prepare: () => ({ key: "main:default", create, reuse: () => true }),
      },
    );
  try {
    await expect(acquire()).rejects.toThrow("reloading");
    expect(create).not.toHaveBeenCalled();
    await expect(reload.drain()).resolves.toEqual({ errors: [] });
  } finally {
    reload.resume();
  }
  expect(await acquire()).toBe(manager);
  await registry.closeAll();
  expect(manager.close).toHaveBeenCalledOnce();
});
