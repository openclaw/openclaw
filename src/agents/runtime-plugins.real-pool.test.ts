// Regression coverage for model-catalog registry reuse through the real loader pool.
//
// This does *not* exercise `loadOpenClawPluginsCore`'s internal per-plugin signature reuse
// (that path is covered by runtime-plugins.real-pool.integration.test.ts). Instead, it spies
// on the public `loadAgentRuntimePluginRegistryHandle` entry point's call site to
// `loadPluginRegistryHandle` and proves that:
//   - every `purpose: "model-catalog"` request always calls the real loader (no direct
//     identity-return fast path in `reusableAgentRuntimeRegistry` any more), and
//   - each call is issued with the full requested plugin id set for that request, and
//     threads the previously-built registry through as `previousRegistry` so the loader's
//     own incremental reuse can retain unchanged plugins across unions.
//
// This keeps the test's original value: a plugin-config change can no longer hide behind
// an identity-shortcut reuse of a stale `PluginRegistry` object; the loader is always
// re-entered with the current requested id set, and only the loader's own per-plugin
// signature matching decides what can be safely retained.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  getActivePluginRegistry: vi.fn(),
  getActivePluginRegistryWorkspaceDir: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
  adoptRuntimeContextEngineRegistrations: vi.fn((target: unknown) => target),
  adoptRuntimeWidgetPresenterRegistrations: vi.fn((target: unknown) => target),
  resolveAgentRuntimePluginLoadPlan: vi.fn(),
  resolveAgentRuntimePluginSelections: vi.fn(
    (_config: unknown, selections: readonly unknown[]) => selections,
  ),
  acquirePluginRegistryForInspection: vi.fn(),
}));

vi.mock("../context-engine/registry.js", () => ({
  adoptRuntimeContextEngineRegistrations: hoisted.adoptRuntimeContextEngineRegistrations,
}));
vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: hoisted.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: hoisted.getActivePluginRegistryWorkspaceDir,
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));
vi.mock("../plugins/widget-presenters.js", () => ({
  adoptRuntimeWidgetPresenterRegistrations: hoisted.adoptRuntimeWidgetPresenterRegistrations,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: hoisted.loadPluginMetadataSnapshot,
}));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: hoisted.loadPluginRegistryHandle,
  acquirePluginRegistryForInspection: hoisted.acquirePluginRegistryForInspection,
}));
vi.mock("./harness/runtime-plugin-load-plan.js", () => ({
  resolveAgentRuntimePluginLoadPlan: hoisted.resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections: hoisted.resolveAgentRuntimePluginSelections,
}));

import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

function makeRegistryFor(ids: readonly string[]) {
  const registry = createEmptyPluginRegistry();
  registry.plugins = ids.map((id) => createPluginRecord({ id }));
  return registry;
}

describe("model-catalog cumulative registry reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getActivePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    hoisted.loadPluginMetadataSnapshot.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      index: { installRecords: {}, plugins: [] },
      manifestRegistry: { diagnostics: [], plugins: [] },
      discovery: { candidates: [], diagnostics: [] },
      pluginIds: undefined,
    });
    hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(
      (params: { config?: unknown; basePluginIds?: readonly string[] }) => ({
        config: params.config ?? {},
        pluginIds: params.basePluginIds ?? [],
      }),
    );
    hoisted.loadPluginRegistryHandle.mockImplementation(
      ({ onlyPluginIds }: { onlyPluginIds: readonly string[] }) => makeRegistryFor(onlyPluginIds),
    );
  });

  it("always routes model-catalog requests through the real loader with previousRegistry threading", () => {
    const registryA = loadAgentRuntimePluginRegistryHandle({
      config: {},
      basePluginIds: ["a"],
      purpose: "model-catalog",
    });

    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        onlyPluginIds: ["a"],
      }),
    );
    expect(registryA.plugins.map((p) => p.id)).toEqual(["a"]);

    const registryAB = loadAgentRuntimePluginRegistryHandle({
      config: {},
      basePluginIds: ["a", "b"],
      reusableRegistry: registryA,
      purpose: "model-catalog",
    });

    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        onlyPluginIds: ["a", "b"],
        previousRegistry: registryA,
      }),
    );
    expect(registryAB.plugins.map((p) => p.id)).toEqual(["a", "b"]);

    // Identical request: still re-enters the real loader with the full id set and
    // previousRegistry threaded through. Any incremental reuse happens inside
    // loadOpenClawPluginsCore, not by short-circuiting the outer entry point.
    const registryABAgain = loadAgentRuntimePluginRegistryHandle({
      config: {},
      basePluginIds: ["a", "b"],
      reusableRegistry: registryAB,
      purpose: "model-catalog",
    });

    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(3);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        onlyPluginIds: ["a", "b"],
        previousRegistry: registryAB,
      }),
    );
    expect(registryABAgain.plugins.map((p) => p.id)).toEqual(["a", "b"]);

    // Strict subset request: still re-enters the loader. The outer layer used to
    // short-circuit here by identity, which could hide plugin-config changes for
    // ids that remained in the base set. Now the loader always sees the current
    // requested id set and the previously-built registry.
    const registryASubset = loadAgentRuntimePluginRegistryHandle({
      config: {},
      basePluginIds: ["a"],
      reusableRegistry: registryAB,
      purpose: "model-catalog",
    });

    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(4);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        onlyPluginIds: ["a"],
        previousRegistry: registryAB,
      }),
    );
    expect(registryASubset.plugins.map((p) => p.id)).toEqual(["a"]);

    // Superset request (a genuinely new plugin id): one more loader call that carries the
    // union id set and the last cumulative registry. The prepared model-runtime lifetime
    // tests cover the successor wiring that promotes this new registry over its
    // predecessor when appropriate.
    const registryABC = loadAgentRuntimePluginRegistryHandle({
      config: {},
      basePluginIds: ["a", "b", "c"],
      reusableRegistry: registryAB,
      purpose: "model-catalog",
    });

    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(5);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        onlyPluginIds: ["a", "b", "c"],
        previousRegistry: registryAB,
      }),
    );
    expect(registryABC.plugins.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});
