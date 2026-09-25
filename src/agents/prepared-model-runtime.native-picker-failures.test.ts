// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
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
import type { AgentHarnessModelCatalogResult } from "./harness/types.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  loadProviderScopedThinkingCatalog,
  loadPublishedPreparedModelCatalogOwnerSnapshot,
} from "./prepared-model-catalog.js";
import * as fullCatalog from "./prepared-model-runtime.full-catalog.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const runtimeFixture = usePreparedModelRuntimeHarness({ label: "native-picker" }, () => {
  vi.restoreAllMocks();
});
const { mocks } = runtimeFixture;

async function fixture(standalone = false, cold = false, runtimeA = "native-a") {
  const { resolveNativeModelPrimary } =
    await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  mocks.resolveNativeModelPrimary.mockImplementation(resolveNativeModelPrimary);
  const a = { provider: "provider-a", id: "model", name: "A", nativeRuntime: runtimeA };
  const b = { provider: "provider-b", id: "model", name: "B", nativeRuntime: "native-b" };
  const loadA = vi.fn<() => Promise<AgentHarnessModelCatalogResult>>(async () => [a]);
  const loadB = vi.fn<() => Promise<AgentHarnessModelCatalogResult>>(async () => [b]);
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
  const observed = await loadPublishedPreparedModelCatalogOwnerSnapshot({
    ...input,
    workspaceDir: owner.workspaceDir,
    readOnly: true,
  });
  expect(observed.modelCatalog.entries).toContainEqual(expect.objectContaining(api));
  expect.soft(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls);
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
    const thinking = await loadProviderScopedThinkingCatalog({
      ...input,
      workspaceDir: owner.workspaceDir,
      provider: selection.provider,
      model: selection.modelId,
      agentRuntime: selection.runtime,
    });
    expect(thinking).toContainEqual(
      expect.objectContaining({
        provider: selection.provider,
        id: selection.modelId,
      }),
    );
    expect.soft(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls);
    expect(lease.snapshot.modelCatalog.entries).toContainEqual(expect.objectContaining(b));
  }
  expect([loadA.mock.calls.length, loadB.mock.calls.length]).toEqual(nativeCalls);

  owner.refreshExpiredModelCatalog!();
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

it("restores the fresh API route when a native harness returns an untagged host model", async () => {
  const { owner, b, loadB } = await fixture(true, true);
  loadB.mockResolvedValue([{ ...b, contextWindow: 8_000 }]);
  await owner.loadFullModelCatalog!({ refresh: true });
  const previousApi = {
    provider: b.provider,
    id: b.id,
    name: "API model",
    api: "openai-completions" as const,
    baseUrl: "https://old.synthetic.test/v1",
    contextWindow: 16_000,
  };
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [previousApi],
    routeVariants: [previousApi],
  });
  const initial = await owner.loadFullModelCatalog!({ refresh: true });
  expect(initial.entries.find((entry) => entry.provider === b.provider)).toMatchObject({
    nativeRuntime: b.nativeRuntime,
    contextWindow: 8_000,
  });
  const freshApi = {
    ...previousApi,
    api: "openai-responses" as const,
    baseUrl: "https://fresh.synthetic.test/v1",
    contextWindow: 32_000,
  };
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [freshApi],
    routeVariants: [freshApi],
  });
  loadB.mockResolvedValue([{ provider: b.provider, id: b.id, name: "Host model" }]);

  const refreshed = await owner.loadFullModelCatalog!({ refresh: true });

  for (const entries of [refreshed.entries, refreshed.routeVariants]) {
    const routes = entries.filter((entry) => entry.provider === b.provider && entry.id === b.id);
    expect(routes).toContainEqual(expect.objectContaining({ ...freshApi, name: "Host model" }));
    expect(routes.some((entry) => entry.nativeRuntime)).toBe(false);
  }
});

it("keeps observed untagged models without restoring API rows deleted during native discovery", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true, true);
  const siblingHost = { provider: a.provider, id: "sibling-host", name: "Sibling host" };
  loadA.mockResolvedValue([siblingHost]);
  const previousApi = {
    provider: b.provider,
    id: b.id,
    name: "API model",
    api: "openai-completions" as const,
    baseUrl: "https://old.synthetic.test/v1",
    contextWindow: 16_000,
  };
  const removedApi = { ...previousApi, id: "removed-api" };
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [previousApi, removedApi],
    routeVariants: [previousApi, removedApi],
  });
  await owner.loadFullModelCatalog!({ refresh: true });
  const harnessOnly = { provider: b.provider, id: "harness-only", name: "Harness-only model" };
  const alternateHost = {
    provider: b.provider,
    id: b.id,
    name: "Account route",
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://account.synthetic.test/v1",
    contextWindow: 48_000,
    params: { accountModel: "account-route-model" },
  };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let renewed = createDeferredCore();
  loadB.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return [
      { provider: b.provider, id: b.id, name: "Observed host model" },
      alternateHost,
      harnessOnly,
    ];
  });
  const selected = owner.loadNativeModelCatalog!({
    provider: b.provider,
    modelId: harnessOnly.id,
    runtime: b.nativeRuntime,
  });
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "catalog-published") {
      renewed.resolve();
    }
  });
  try {
    await entered.promise;
    const freshApi = {
      ...previousApi,
      api: "openai-responses" as const,
      baseUrl: "https://fresh.synthetic.test/v1",
      contextWindow: 32_000,
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [freshApi],
      routeVariants: [freshApi],
    });
    const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
    inventory.providers.get(b.provider)!.expiresAt = 0;
    owner.refreshExpiredModelCatalog!();
    await renewed.promise;
    const providerPublication = owner.readFullModelCatalog!()!;
    expect(providerPublication.routeVariants).toContainEqual(expect.objectContaining(freshApi));
    expect(providerPublication.routeVariants.some((entry) => entry.id === removedApi.id)).toBe(
      false,
    );
    release.resolve();
    const catalog = await selected;
    expect(catalog.routeVariants).toContainEqual(expect.objectContaining(alternateHost));
    for (const entries of [catalog.entries, catalog.routeVariants]) {
      expect(entries).toContainEqual(expect.objectContaining(harnessOnly));
      expect(entries).toContainEqual(
        expect.objectContaining({ ...freshApi, name: "Observed host model" }),
      );
      expect(entries).toContainEqual(expect.objectContaining(siblingHost));
      expect(entries.some((entry) => entry.id === removedApi.id)).toBe(false);
      expect(entries.some((entry) => entry.provider === b.provider && entry.nativeRuntime)).toBe(
        false,
      );
    }
    const nativeCalls = loadB.mock.calls.length;
    const latestApi = { ...freshApi, contextWindow: 64_000 };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [latestApi],
      routeVariants: [latestApi],
    });
    renewed = createDeferredCore();
    resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!.providers.get(
      b.provider,
    )!.expiresAt = 0;
    owner.refreshExpiredModelCatalog!();
    await renewed.promise;
    expect(loadB).toHaveBeenCalledTimes(nativeCalls);
    expect(owner.readFullModelCatalog!()?.routeVariants).toContainEqual(
      expect.objectContaining(alternateHost),
    );
    for (const entries of [
      owner.readFullModelCatalog!()!.entries,
      owner.readFullModelCatalog!()!.routeVariants,
    ]) {
      expect(entries).toContainEqual(expect.objectContaining(harnessOnly));
      expect(entries).toContainEqual(
        expect.objectContaining({ ...latestApi, name: "Observed host model" }),
      );
      expect(entries.some((entry) => entry.id === removedApi.id)).toBe(false);
    }
    const selection = { provider: b.provider, modelId: harnessOnly.id, runtime: b.nativeRuntime };
    loadB.mockRejectedValueOnce(new Error("Host discovery unavailable"));
    await owner.loadNativeModelCatalog!(selection).catch(() => undefined);
    expect(owner.readFullModelCatalog!()?.entries).toContainEqual(
      expect.objectContaining(harnessOnly),
    );
    loadB.mockResolvedValue([]);
    const cleared = await owner.loadNativeModelCatalog!(selection);
    for (const entries of [cleared.entries, cleared.routeVariants]) {
      expect(entries.some((entry) => entry.id === harnessOnly.id)).toBe(false);
      expect(entries).toContainEqual(expect.objectContaining(latestApi));
      expect(entries).toContainEqual(expect.objectContaining(siblingHost));
    }
    expect(cleared.refreshFailed).toBeUndefined();
    expect(cleared.routeVariants.some((entry) => entry.baseUrl === alternateHost.baseUrl)).toBe(
      false,
    );
  } finally {
    release.resolve();
    await selected.catch(() => undefined);
    unregister();
  }
});

it("publishes fresh API models when every native harness fails during a full refresh", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true, true);
  const previousApi = { provider: "api-provider", id: "old-api", name: "Old API model" };
  const ready = { provider: previousApi.provider, status: "ready" } as const;
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [previousApi],
    routeVariants: [previousApi],
    providerOutcomes: [ready],
  });
  await owner.loadFullModelCatalog!({ refresh: true });
  const freshApi = { ...previousApi, id: "fresh-api", name: "Fresh API model" };
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [freshApi],
    routeVariants: [freshApi],
    providerOutcomes: [ready],
  });
  loadA.mockRejectedValue(new Error("Native A unavailable"));
  loadB.mockRejectedValue(new Error("Native B unavailable"));

  await owner.loadFullModelCatalog!({ refresh: true }).catch(() => undefined);

  const catalog = owner.readFullModelCatalog!()!;
  for (const entries of [catalog.entries, catalog.routeVariants]) {
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining(freshApi),
        expect.objectContaining(a),
        expect.objectContaining(b),
      ]),
    );
    expect(entries.some((entry) => entry.id === previousApi.id)).toBe(false);
  }
  expect(catalog).toMatchObject({ authoritative: false, refreshFailed: true });
  expect(catalog.providerOutcomes).toContainEqual(ready);
  expect(catalog.pendingProviders).toBeUndefined();
});

it("keeps a newly selected native model when a queued full refresh partly fails", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true, true);
  await owner.loadFullModelCatalog!({ refresh: true });
  const updatedA = { ...a, id: "updated-a", name: "Updated A" };
  const updatedB = { ...b, id: "selected-b", name: "Selected B" };
  const selectionEntered = createDeferredCore();
  const releaseSelection = createDeferredCore();
  const providerCompleted = createDeferredCore();
  loadA.mockResolvedValue([updatedA]);
  loadB.mockImplementationOnce(async () => {
    selectionEntered.resolve();
    await releaseSelection.promise;
    return [updatedB];
  });
  loadB.mockRejectedValue(new Error("Native B unavailable during full refresh"));
  const selected = owner.loadNativeModelCatalog!({
    provider: updatedB.provider,
    modelId: updatedB.id,
    runtime: updatedB.nativeRuntime,
  });
  await selectionEntered.promise;
  mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
    providerCompleted.resolve();
    return { entries: [], routeVariants: [] };
  });
  const refreshed = owner.loadFullModelCatalog!({ refresh: true });
  try {
    await providerCompleted.promise;
    // Drain provider completion so the full refresh is waiting on the held native selection.
    await nextEventLoopTurn();
    expect(loadA).toHaveBeenCalledOnce();
    expect(loadB).toHaveBeenCalledTimes(2);
    releaseSelection.resolve();
    expect((await selected).entries).toContainEqual(expect.objectContaining(updatedB));
    const catalog = await refreshed;
    expect(catalog).toMatchObject({ authoritative: false, refreshFailed: true });
    for (const entries of [catalog.entries, catalog.routeVariants]) {
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining(updatedA),
          expect.objectContaining(updatedB),
        ]),
      );
      expect(entries.some((entry) => entry.provider === b.provider && entry.id === b.id)).toBe(
        false,
      );
    }
  } finally {
    releaseSelection.resolve();
    await Promise.allSettled([selected, refreshed]);
  }
});

it.each(["native-a", "__proto__", "constructor"])(
  "publishes native failures through provider renewals, retaining siblings until recovery (%s)",
  async (runtimeA) => {
    const { owner, a, b, loadA, loadB } = await fixture(true, false, runtimeA);
    const api = { provider: "api-provider", id: "model", name: "API model" };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [api],
      routeVariants: [api],
      providerOutcomes: [{ provider: api.provider, status: "ready" }],
    });
    loadB.mockResolvedValue({
      entries: [b],
      outcomes: [{ provider: b.provider, status: "ready" }],
    });
    await owner.loadFullModelCatalog!({ refresh: true });
    if (runtimeA === "constructor") {
      await owner.loadFullModelCatalog!({ refresh: true, providerIds: [a.provider] });
    }
    const failure = {
      provider: a.provider,
      status: "auth-rejected",
      rejectionScope: "catalog",
    } as const;
    const updatedB = { ...b, name: "Updated native B" };
    loadA.mockResolvedValue({
      entries: [],
      outcomes: [{ ...failure, provider: ` ${a.provider.toUpperCase()} ` }],
    });
    loadB.mockResolvedValue({
      entries: [updatedB],
      outcomes: [{ provider: b.provider, status: "ready" }],
    });
    const partial = await owner.loadFullModelCatalog!({ refresh: true });
    expect(partial).toMatchObject({ authoritative: false, refreshFailed: true });
    expect(partial.providerOutcomes).toContainEqual(failure);
    expect(partial.entries).toEqual(
      expect.arrayContaining([expect.objectContaining(a), expect.objectContaining(updatedB)]),
    );

    const nativeCalls = loadA.mock.calls.length;
    const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
    inventory.providers.get(api.provider)!.expiresAt = 0;
    const published = createDeferredCore();
    const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-published") {
        published.resolve();
      }
    });
    try {
      owner.refreshExpiredModelCatalog!();
      await published.promise;
    } finally {
      unsubscribe();
    }
    const renewed = owner.readFullModelCatalog!()!;
    expect(loadA).toHaveBeenCalledTimes(nativeCalls);
    expect(renewed).toMatchObject({ authoritative: false, refreshFailed: true });
    expect(renewed.providerOutcomes).toContainEqual(failure);
    expect(renewed.entries).toContainEqual(expect.objectContaining(updatedB));

    // An empty successful result also represents disabled or missing optional apps.
    loadA.mockResolvedValue({ entries: [] });
    const cleared = await owner.loadFullModelCatalog!({ refresh: true });
    expect(cleared.refreshFailed).toBeUndefined();
    expect(cleared.providerOutcomes?.some(({ provider }) => provider === a.provider)).toBe(false);
    expect(cleared.entries.some(({ provider }) => provider === a.provider)).toBe(false);
    expect(cleared.entries).toContainEqual(expect.objectContaining(updatedB));
  },
);

it("keeps API provider readiness independent of a failed native runtime for the same provider", async () => {
  const { owner, a, loadA } = await fixture(true);
  const api = { provider: a.provider, id: "api-model", name: "API model" };
  const ready = { provider: a.provider, status: "ready" } as const;
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [api],
    routeVariants: [api],
    providerOutcomes: [ready],
  });
  loadA.mockResolvedValue({
    entries: [],
    outcomes: [{ provider: a.provider, status: "unavailable", rejectionScope: "catalog" }],
  });
  const partial = await owner.loadFullModelCatalog!({ refresh: true });
  expect(partial.refreshFailed).toBe(true);
  expect(partial.providerOutcomes?.filter(({ provider }) => provider === a.provider)).toEqual([
    ready,
  ]);
  expect(partial.entries).toContainEqual(expect.objectContaining(api));
  loadA.mockResolvedValue({ entries: [] });
  const recovered = await owner.loadFullModelCatalog!({ refresh: true });
  expect(recovered.refreshFailed).toBeUndefined();
  expect(recovered.providerOutcomes?.filter(({ provider }) => provider === a.provider)).toEqual([
    ready,
  ]);
});

it.each([false, true])(
  "rejects native readiness that retires its owner (after queue: %s)",
  async (afterQueue) => {
    const { owner, b, loadB } = await fixture(true, true);
    await owner.loadFullModelCatalog!({ refresh: true });
    const calls = loadB.mock.calls.length;
    const readReadiness = vi.fn(() => {
      markPreparedModelRuntimeSnapshotsStale();
      return { accountType: "native" };
    });
    const nativeHarness = owner.pluginRegistry!.agentHarnesses.find(
      (registration) => registration.harness.id === b.nativeRuntime,
    )!.harness;
    nativeHarness.readModelCatalogReadiness = afterQueue
      ? vi.fn().mockReturnValueOnce(undefined).mockImplementation(readReadiness)
      : readReadiness;

    await expect(
      owner.loadNativeModelCatalog!({
        provider: b.provider,
        modelId: b.id,
        runtime: b.nativeRuntime,
      }),
    ).rejects.toThrow("superseded");
    expect(owner.isCurrent()).toBe(false);
    expect(readReadiness).toHaveBeenCalledOnce();
    expect(loadB).toHaveBeenCalledTimes(calls);
  },
);

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
