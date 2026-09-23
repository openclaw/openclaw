// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveEmbeddedRunModelSetup } from "./embedded-agent-runner/run/model-setup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { loadProviderScopedThinkingCatalog } from "./prepared-model-catalog.js";
import * as fullCatalog from "./prepared-model-runtime.full-catalog.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const runtimeFixture = usePreparedModelRuntimeHarness({ label: "native-picker" }, () => {
  vi.restoreAllMocks();
});
const { mocks } = runtimeFixture;

async function fixture(standalone = false, cold = false) {
  const { resolveNativeModelPrimary } =
    await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  mocks.resolveNativeModelPrimary.mockImplementation(resolveNativeModelPrimary);
  const a = { provider: "provider-a", id: "model", name: "A", nativeRuntime: "native-a" };
  const b = { provider: "provider-b", id: "model", name: "B", nativeRuntime: "native-b" };
  const loadA = vi.fn(async () => [a]);
  const loadB = vi.fn(async () => [b]);
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    for (const [entry, loadModelCatalog] of [
      [a, loadA],
      [b, loadB],
    ] as const) {
      registry.agentHarnesses.push({
        pluginId: entry.nativeRuntime,
        source: "fixture",
        harness: {
          id: entry.nativeRuntime,
          label: entry.name,
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog,
        },
      });
    }
    return registry;
  });
  const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
  const input = {
    config,
    agentId: "pro",
    agentDir: runtimeFixture.state.agentDir("pro"),
    allowGatewaySubagentBinding: true,
  };
  mocks.configuredAgentIds = ["pro"];
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries: [], routeVariants: [] });
  if (!standalone) {
    // Gateway commits start background discovery. Publish the cold owner separately after activation.
    if (cold) {
      mocks.configuredAgentIds = [];
    }
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    mocks.configuredAgentIds = ["pro"];
  }
  const owner =
    standalone || cold
      ? await publishPreparedModelRuntimeSnapshot(input, {
          catalogMode: "static",
          provenance: standalone ? "standalone" : "configured",
        })
      : getPreparedModelRuntimeSnapshot(input)!;
  return { input, owner, a, b, loadA, loadB };
}

it("reuses native thinking observations across messages and refreshes invalidated owners", async () => {
  const { input, owner, a, b, loadA, loadB } = await fixture();
  const previous = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(owner.pluginRegistry!);
  try {
    const read = (entry: typeof b) =>
      withPluginRuntimeGenerationScope(owner, () =>
        loadProviderScopedThinkingCatalog({
          config: input.config,
          agentId: input.agentId,
          agentDir: input.agentDir,
          workspaceDir: owner.workspaceDir,
          provider: entry.provider,
          model: entry.id,
          agentRuntime: entry.nativeRuntime,
        }),
      );
    const first = await read(b);
    expect(first).toContainEqual(expect.objectContaining(b));
    expect(first.find((entry) => entry.provider === b.provider)?.reasoning).toBeUndefined();
    expect(await read(b)).toContainEqual(expect.objectContaining(b));
    expect.soft(loadB).toHaveBeenCalledOnce();
    expect(loadA).toHaveBeenCalledOnce();
    expect(await read(a)).toContainEqual(expect.objectContaining(a));
    expect.soft(loadB).toHaveBeenCalledOnce();
    expect(loadA).toHaveBeenCalledOnce();

    const updated = { ...b, reasoning: true, input: ["text", "image"] } satisfies ModelCatalogEntry;
    loadB.mockResolvedValue([updated]);
    await owner.loadFullModelCatalog!({ refresh: true });
    const refreshedCalls = loadB.mock.calls.length;
    expect(await read(b)).toContainEqual(expect.objectContaining(updated));
    expect.soft(loadB).toHaveBeenCalledTimes(refreshedCalls);

    const nativeHarness = owner.pluginRegistry!.agentHarnesses.find(
      (registration) => registration.harness.id === b.nativeRuntime,
    )!.harness;
    let ready = false;
    nativeHarness.readModelCatalogReadiness = () => (ready ? { accountType: "native" } : undefined);
    loadB.mockImplementation(async () => {
      ready = true;
      return [updated];
    });
    expect(await read(b)).toContainEqual(expect.objectContaining(updated));
    expect(await read(b)).toContainEqual(expect.objectContaining(updated));
    expect.soft(loadB).toHaveBeenCalledTimes(refreshedCalls + 1);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
  } finally {
    restoreActivePluginRegistrySnapshot(previous);
  }
});

it("reuses published native facts without renewing providers during warm API and native turns", async () => {
  const { input, owner, b, loadA, loadB } = await fixture();
  const api = { provider: "provider-c", id: "model", name: "API model" };
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [api],
    routeVariants: [api],
  });
  await owner.loadFullModelCatalog!({ refresh: true });
  const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
  inventory.providers.get(api.provider)!.expiresAt = 0;
  const providerCalls = mocks.runPreparedModelCatalogWorker.mock.calls.length;
  const nativeCalls = [loadA.mock.calls.length, loadB.mock.calls.length];
  for (const selection of [
    { provider: api.provider, modelId: api.id, runtime: "openclaw" },
    { provider: b.provider, modelId: b.id, runtime: b.nativeRuntime },
  ]) {
    const selected = {
      ...input,
      workspaceDir: owner.workspaceDir,
      runtimePluginSelections: [selection],
    };
    await using lease = await acquireAgentRunPreparedModelRuntime(selected);
    expect.soft(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls);
    expect(lease.snapshot.modelCatalog.entries).toContainEqual(expect.objectContaining(b));
  }
  expect([loadA.mock.calls.length, loadB.mock.calls.length]).toEqual(nativeCalls);

  owner.readFullModelCatalog!();
  await vi.waitFor(() => {
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls + 1);
  });
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenLastCalledWith([api.provider]);
});

it.each([false, true])(
  "carries a cold native selection into a stable run lease (standalone=%s)",
  async (standalone) => {
    const { input, owner, b, loadA, loadB } = await fixture(standalone, true);
    expect(loadA).not.toHaveBeenCalled();
    expect(loadB).not.toHaveBeenCalled();
    const selected = {
      ...input,
      workspaceDir: owner.workspaceDir,
      runtimePluginSelections: [
        {
          provider: b.provider,
          modelId: b.id,
          runtime: b.nativeRuntime,
          agentId: "pro",
        },
      ],
    };
    await using lease = await acquireAgentRunPreparedModelRuntime(selected, {
      catalogMode: "static",
    });
    const coldCatalog = lease.snapshot.modelCatalog;
    const workspaceDir = lease.snapshot.workspaceDir!;
    const setup = await withPluginRuntimeGenerationScope(lease.snapshot, () =>
      resolveEmbeddedRunModelSetup({
        assertCurrent: () => {},
        runParams: {
          config: input.config,
          agentId: "pro",
          sessionId: "cold",
          runId: "cold",
          workspaceDir,
          prompt: "Use the saved native choice",
          timeoutMs: 30000,
          agentHarnessRuntimeOverride: b.nativeRuntime,
        },
        provider: b.provider,
        modelId: b.id,
        agentDir: input.agentDir,
        workspaceDir,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: "cold", workspaceDir },
        onHooksResolved: () => {},
        preparedModelRuntime: lease.snapshot,
      }),
    );
    expect(setup.nativeModelOwned).toBe(true);
    expect(setup.agentHarness.id).toBe(b.nativeRuntime);
    expect(setup.model).toMatchObject({ provider: b.provider, id: b.id });
    expect(loadB).toHaveBeenCalledOnce();
    if (standalone) {
      expect(loadA).not.toHaveBeenCalled();
    }
    await using reused = await acquireAgentRunPreparedModelRuntime(selected, {
      catalogMode: "static",
    });
    expect(reused.snapshot.modelCatalog.entries).toContainEqual(expect.objectContaining(b));
    expect(loadB).toHaveBeenCalledOnce();
    const captured = reused.snapshot.modelCatalog;
    const catalogOwner = standalone ? reused.snapshot : owner;
    loadA.mockResolvedValue([]);
    loadB.mockResolvedValue([]);
    const empty = await catalogOwner.loadFullModelCatalog!({ refresh: true });
    expect(fullCatalog.isPreparedModelCatalogFull(empty)).toBe(true);
    await using next = await acquireAgentRunPreparedModelRuntime(selected, {
      catalogMode: "static",
    });
    expect(next.snapshot.modelCatalog.entries.some((entry) => entry.nativeRuntime)).toBe(false);
    expect(next.snapshot.modelCatalog.routeVariants.some((entry) => entry.nativeRuntime)).toBe(
      false,
    );
    expect(lease.snapshot.modelCatalog).toBe(coldCatalog);
    expect(reused.snapshot.modelCatalog).toBe(captured);
    expect(captured.entries).toContainEqual(expect.objectContaining(b));
  },
);

it("does not share a failed pending native discovery with another runtime, and recovers explicitly", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const failure = new Error("Native A unavailable");
  loadA.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  const selected = { provider: b.provider, modelId: b.id };
  const first = owner.loadNativeModelCatalog!({ ...selected, runtime: a.nativeRuntime });
  const rejected = expect(first).rejects.toBe(failure);
  await entered.promise;
  const second = owner.loadNativeModelCatalog!({ ...selected, runtime: b.nativeRuntime });
  release.resolve();
  await rejected;
  expect((await second).entries).toContainEqual(expect.objectContaining(b));
  expect(loadA).toHaveBeenCalledOnce();
  expect(loadB).toHaveBeenCalledOnce();
  const partial = await owner.loadFullModelCatalog!({ refresh: true });
  expect(partial).toMatchObject({ authoritative: false, refreshFailed: true });
  expect(partial.entries).toContainEqual(expect.objectContaining(b));
  const calls = loadB.mock.calls.length;
  expect(await owner.loadFullModelCatalog!()).toBe(partial);
  expect(loadB).toHaveBeenCalledTimes(calls);
  loadA.mockResolvedValue([a]);
  const recovered = await owner.loadFullModelCatalog!({ refresh: true });
  expect(recovered.entries).toEqual(
    expect.arrayContaining([expect.objectContaining(a), expect.objectContaining(b)]),
  );
  expect(recovered.authoritative).not.toBe(false);
  expect(recovered.refreshFailed).toBeUndefined();
});

it("does not publish a pending native refresh after its owner is replaced", async () => {
  const { owner, input, loadB } = await fixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  loadB.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("Old discovery failed");
  });
  const refresh = expect(owner.loadFullModelCatalog!({ refresh: true })).rejects.toThrow(
    "superseded",
  );
  try {
    await entered.promise;
    await refreshPreparedModelRuntimeSnapshots(
      {
        ...input.config,
        agents: { ...input.config.agents, defaults: { model: "provider-a/replacement" } },
      },
      { gatewayLifecycle: true, catalogMode: "static" },
    );
  } finally {
    release.resolve();
  }
  await refresh;
  expect(owner.isCurrent()).toBe(false);
});
