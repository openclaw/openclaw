import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import type { applyHermesPlan } from "./apply.js";
import pluginEntry from "./index.js";
import type { HermesSource } from "./source.js";
import { makeContext } from "./test/provider-helpers.js";

const mocks = vi.hoisted(() => ({
  loaded: [] as string[],
  load<T>(name: string, exports: T): T {
    mocks.loaded.push(name);
    return exports;
  },
  discover: vi.fn<(input?: string) => Promise<HermesSource>>(),
  hasSource: vi.fn<(source: HermesSource) => boolean>(),
  memoryOnly: vi.fn<(ctx: MigrationProviderContext) => boolean>(),
  plan: vi.fn<(ctx: MigrationProviderContext) => Promise<MigrationPlan>>(),
  apply: vi.fn<typeof applyHermesPlan>(),
}));

// mock-isolation: Track lazy imports without loading filesystem readers or executing migrations.
vi.mock("./source.js", () =>
  mocks.load("source", { discoverHermesSource: mocks.discover, hasHermesSource: mocks.hasSource }),
);
// mock-isolation: Track lazy memory-module loading without importing its runtime dependencies.
vi.mock("./memory.js", () => mocks.load("memory", { isMemoryOnlyMigration: mocks.memoryOnly }));
// mock-isolation: Track plan loading and hold fixture-owned planning promises.
vi.mock("./plan.js", () => mocks.load("plan", { buildHermesPlan: mocks.plan }));
// mock-isolation: Track apply loading without executing real migration writes.
vi.mock("./apply.js", () => mocks.load("apply", { applyHermesPlan: mocks.apply }));

it("registers synchronously and loads only the invoked migration operations", async () => {
  const register = vi.fn<(provider: MigrationProviderPlugin) => void>();
  const api = createTestPluginApi({ registerMigrationProvider: register });
  expect(pluginEntry.register(api)).toBeUndefined();
  const provider = register.mock.calls[0]?.[0];
  assert(provider, "Hermes provider was not registered");
  expect([provider.id, provider.supportedItemKinds]).toEqual(["hermes", ["memory"]]);
  expect(mocks.loaded).toEqual([]);

  const ctx = makeContext({ source: "/hermes", stateDir: "/state", workspaceDir: "/workspace" });
  const source: HermesSource = { root: "/hermes", archivePaths: [] };
  mocks.discover.mockResolvedValue(source);
  mocks.hasSource.mockReturnValue(true);
  mocks.memoryOnly.mockReturnValue(false);
  await provider.detect?.(ctx);
  expect(mocks.loaded).toEqual(["source", "memory"]);

  mocks.memoryOnly.mockReturnValue(true);
  await expect(provider.detect?.(ctx)).resolves.toMatchObject({ found: false, confidence: "low" });
  mocks.discover.mockResolvedValue({ ...source, memoryPath: "/hermes/memories/MEMORY.md" });
  await expect(provider.detect?.(ctx)).resolves.toMatchObject({ found: true });

  const plan: MigrationPlan = {
    providerId: "hermes",
    source: source.root,
    items: [],
    summary: summarizeMigrationItems([]),
  };
  const firstPlanStarted = createDeferred<void>();
  const secondPlanStarted = createDeferred<void>();
  const finishPlans = createDeferred<MigrationPlan>();
  mocks.plan.mockImplementation(() => {
    (mocks.plan.mock.calls.length === 1 ? firstPlanStarted : secondPlanStarted).resolve();
    return finishPlans.promise;
  });
  const firstPlan = provider.plan(ctx);
  // Keep both plans pending without concurrent Vitest manual-mock imports.
  await firstPlanStarted.promise;
  const secondPlan = provider.plan(ctx);
  await secondPlanStarted.promise;
  finishPlans.resolve(plan);
  (await Promise.all([firstPlan, secondPlan])).forEach((result) => expect(result).toBe(plan));
  expect(mocks.loaded).toEqual(["source", "memory", "plan"]);

  const result = { ...plan, reportDir: "/report" };
  mocks.apply.mockResolvedValue(result);
  await expect(provider.apply(ctx, plan)).resolves.toBe(result);
  expect(mocks.apply).toHaveBeenLastCalledWith({ ctx, plan, runtime: api.runtime });
  await expect(provider.apply(ctx)).resolves.toBe(result);
  expect(mocks.apply).toHaveBeenLastCalledWith({ ctx, plan: undefined, runtime: api.runtime });
  expect(mocks.loaded).toEqual(["source", "memory", "plan", "apply"]);

  const failure = new Error("migration operation failed");
  mocks.discover.mockRejectedValueOnce(failure);
  await expect(provider.detect?.(ctx)).rejects.toBe(failure);
  mocks.plan.mockRejectedValueOnce(failure);
  await expect(provider.plan(ctx)).rejects.toBe(failure);
  mocks.apply.mockRejectedValueOnce(failure);
  await expect(provider.apply(ctx, plan)).rejects.toBe(failure);
});
