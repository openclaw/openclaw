import type {
  MigrationApplyResult,
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
  discover: vi.fn<(input?: string) => Promise<HermesSource>>(),
  hasSource: vi.fn<(source: HermesSource) => boolean>(),
  memoryOnly: vi.fn<(ctx: MigrationProviderContext) => boolean>(),
  plan: vi.fn<(ctx: MigrationProviderContext) => Promise<MigrationPlan>>(),
  apply: vi.fn<typeof applyHermesPlan>(),
}));

vi.mock("./source.js", () => {
  mocks.loaded.push("source");
  return { discoverHermesSource: mocks.discover, hasHermesSource: mocks.hasSource };
});
vi.mock("./memory.js", () => {
  mocks.loaded.push("memory");
  return { isMemoryOnlyMigration: mocks.memoryOnly };
});
vi.mock("./plan.js", () => {
  mocks.loaded.push("plan");
  return { buildHermesPlan: mocks.plan };
});
vi.mock("./apply.js", () => {
  mocks.loaded.push("apply");
  return { applyHermesPlan: mocks.apply };
});

it("registers synchronously and loads only the invoked migration operations", async () => {
  const register = vi.fn<(provider: MigrationProviderPlugin) => void>();
  const api = createTestPluginApi({ registerMigrationProvider: register });
  expect(pluginEntry.register(api)).toBeUndefined();
  expect(register).toHaveBeenCalledTimes(1);
  const provider = register.mock.calls[0]?.[0];
  if (!provider) {
    throw new Error("Hermes provider was not registered");
  }
  expect(provider).toMatchObject({
    id: "hermes",
    label: "Hermes",
    description: "Import Hermes config, memories, skills, and supported credentials.",
    supportedItemKinds: ["memory"],
  });
  expect(mocks.loaded).toEqual([]);

  const ctx = makeContext({ source: "/hermes", stateDir: "/state", workspaceDir: "/workspace" });
  const source: HermesSource = { root: "/hermes", archivePaths: [] };
  mocks.discover.mockResolvedValue(source);
  mocks.hasSource.mockReturnValue(true);
  mocks.memoryOnly.mockReturnValue(false);
  await expect(provider.detect?.(ctx)).resolves.toEqual({
    found: true,
    source: source.root,
    label: "Hermes",
    confidence: "high",
    message: "Hermes state found.",
  });
  expect(mocks.discover).toHaveBeenCalledWith(ctx.source);
  expect(mocks.memoryOnly).toHaveBeenCalledWith(ctx);
  expect(mocks.loaded).toEqual(["source", "memory"]);

  mocks.memoryOnly.mockReturnValue(true);
  await expect(provider.detect?.(ctx)).resolves.toMatchObject({ found: false, confidence: "low" });
  mocks.discover.mockResolvedValue({ ...source, memoryPath: "/hermes/memories/MEMORY.md" });
  await expect(provider.detect?.(ctx)).resolves.toMatchObject({ found: true });
  expect(mocks.hasSource).toHaveBeenCalledTimes(1);

  const plan: MigrationPlan = {
    providerId: "hermes",
    source: source.root,
    items: [],
    summary: {
      total: 0,
      planned: 0,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
  };
  mocks.plan.mockResolvedValue(plan);
  const planned = await Promise.all([provider.plan(ctx), provider.plan(ctx)]);
  expect(planned[0]).toBe(plan);
  expect(planned[1]).toBe(plan);
  expect(mocks.plan).toHaveBeenNthCalledWith(1, ctx);
  expect(mocks.plan).toHaveBeenNthCalledWith(2, ctx);
  expect(mocks.loaded).toEqual(["source", "memory", "plan"]);

  const result: MigrationApplyResult = { ...plan, reportDir: "/report" };
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
