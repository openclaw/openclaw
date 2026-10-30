// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OAuthCredential } from "./auth-profiles/types.js";
import { resolveEmbeddedRunModelSetup } from "./embedded-agent-runner/run/model-setup.js";
import type { AgentHarnessModelCatalogResult } from "./harness/types.js";
import { harnessRegistry, oauth } from "./model-catalog-fixtures.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  loadProviderScopedThinkingCatalog,
  loadPublishedPreparedModelCatalogOwnerSnapshot,
} from "./prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePreparedModelRuntimeSnapshot,
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const runtimeFixture = usePreparedModelRuntimeHarness({ label: "native-picker" }, () => {
  vi.restoreAllMocks();
});
const { mocks } = runtimeFixture;

function setProviderCatalog(
  entries: ModelCatalogEntry[],
  providerOutcomes?: ModelCatalogSnapshot["providerOutcomes"],
) {
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries,
    routeVariants: [...entries],
    ...(providerOutcomes ? { providerOutcomes } : {}),
  });
}

function expectModels(
  actual: readonly ModelCatalogEntry[] | undefined,
  ...expected: Partial<ModelCatalogEntry>[]
) {
  for (const model of expected) {
    expect(actual).toContainEqual(expect.objectContaining(model));
  }
}

function expectMissing(entries: readonly ModelCatalogEntry[], model: Partial<ModelCatalogEntry>) {
  expect(entries).not.toContainEqual(expect.objectContaining(model));
}

function catalogLists(catalog: ModelCatalogSnapshot) {
  return [catalog.entries, catalog.routeVariants];
}

function apiRoute(
  base: ModelCatalogEntry,
  api: ModelCatalogEntry["api"],
  host: string,
  contextWindow: number,
) {
  return { ...base, api, baseUrl: `https://${host}.synthetic.test/v1`, contextWindow };
}

function holdDiscovery<T>(result: () => T) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered: entered.promise,
    release: release.resolve,
    load: async () => {
      entered.resolve();
      await release.promise;
      return result();
    },
  };
}

function installHarnesses(
  ...entries: [
    ModelCatalogEntry & { nativeRuntime: string },
    () => Promise<AgentHarnessModelCatalogResult>,
  ][]
) {
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    for (const [entry, loadModelCatalog] of entries) {
      registry.agentHarnesses.push(
        ...harnessRegistry(entry.nativeRuntime, { loadModelCatalog }).agentHarnesses,
      );
    }
    return registry;
  });
}

function expectNativeSetup(
  setup: Awaited<ReturnType<typeof resolveNativeSelection>>,
  model: { provider: string; id: string; nativeRuntime: string },
) {
  expect(setup).toMatchObject({
    nativeModelOwned: true,
    agentHarness: { id: model.nativeRuntime },
    model: { provider: model.provider, id: model.id },
  });
}

function nativeSelection(
  entry: Pick<ModelCatalogEntry, "provider" | "id"> & { nativeRuntime: string },
  modelId = entry.id,
) {
  return { provider: entry.provider, modelId, runtime: entry.nativeRuntime };
}

async function renewProvider(owner: PreparedModelRuntimeSnapshot, provider: string) {
  const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
  inventory.providers.get(provider)!.expiresAt = 0;
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
}

async function fixture(standalone = false, cold = false, runtimeA = "native-a") {
  const { resolveNativeModelPrimary } =
    await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  mocks.resolveNativeModelPrimary.mockImplementation(resolveNativeModelPrimary);
  const a = { provider: "provider-a", id: "model", name: "A", nativeRuntime: runtimeA };
  const b = { provider: "provider-b", id: "model", name: "B", nativeRuntime: "native-b" };
  const loadA = vi.fn<() => Promise<AgentHarnessModelCatalogResult>>(async () => [a]);
  const loadB = vi.fn<() => Promise<AgentHarnessModelCatalogResult>>(async () => [b]);
  installHarnesses([a, loadA], [b, loadB]);
  const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
  const input = {
    config,
    agentId: "pro",
    agentDir: runtimeFixture.state.agentDir("pro"),
    allowGatewaySubagentBinding: true,
  };
  mocks.configuredAgentIds = ["pro"];
  setProviderCatalog([]);
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
  if (!standalone && !cold) {
    await owner.loadFullModelCatalog!();
  }
  return { input, owner, a, b, loadA, loadB };
}

async function resolveNativeSelection(
  input: PreparedModelRuntimeInput,
  lease: PreparedModelRuntimeLease,
  selected: { provider: string; id: string; nativeRuntime: string },
  assertCurrent = () => {},
) {
  const workspaceDir = lease.snapshot.workspaceDir!;
  const preparedModelRuntime = Object.freeze({
    ...lease.snapshot,
    repoRoot: workspaceDir,
    projectKey: "native-selection-project",
    activeProjectKeys: ["native-selection-project"],
  });
  return await withPluginRuntimeGenerationScope(preparedModelRuntime, () =>
    resolveEmbeddedRunModelSetup({
      assertCurrent,
      runParams: {
        config: input.config,
        agentId: input.agentId,
        sessionId: "cold",
        runId: "cold",
        workspaceDir,
        prompt: "Use the saved native choice",
        timeoutMs: 30000,
        agentHarnessRuntimeOverride: selected.nativeRuntime,
      },
      provider: selected.provider,
      modelId: selected.id,
      agentDir: input.agentDir,
      workspaceDir,
      globalLane: "test",
      hookRunner: undefined,
      hookContext: { sessionId: "cold", workspaceDir },
      onHooksResolved: () => {},
      preparedModelRuntime,
    }),
  );
}

it("reuses published native facts without renewing providers during warm API and native turns", async () => {
  const { input, owner, b, loadA, loadB } = await fixture();
  // Settle startup's full acquisition so the refresh below discovers the new provider rows.
  await owner.loadFullModelCatalog!();
  const api = { provider: "provider-c", id: "model", name: "API model" };
  const native = { ...b, reasoning: true, input: ["text", "image"] } satisfies ModelCatalogEntry;
  loadB.mockResolvedValue([native]);
  setProviderCatalog([api]);
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
  expectModels(observed.modelCatalog.entries, api);
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
    expectModels(thinking, selection.runtime === b.nativeRuntime ? native : api);
    expect.soft(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls);
    expectModels(lease.snapshot.modelCatalog.entries, b);
  }
  expect([loadA.mock.calls.length, loadB.mock.calls.length]).toEqual(nativeCalls);

  owner.refreshExpiredModelCatalog!();
  await vi.waitFor(() => {
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls + 1);
  });
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenLastCalledWith([api.provider]);
});

it.each(["before", "during", "revoked"] as const)(
  "keeps native selection bound to its admitted lease (publication/authority=%s)",
  async (transition) => {
    const { input, owner, b, loadB } = await fixture(false, true);
    await using lease = await acquirePreparedModelRuntimeSnapshot(input);
    let leaseOpen = true;
    let runCurrent = true;
    const replacePublication = async () => {
      await publishPreparedModelRuntimeSnapshot(input, {
        force: true,
        catalogMode: "static",
        provenance: "configured",
      });
      expect(owner.isCurrent()).toBe(false);
    };
    const discovery = holdDiscovery(() => [b]);
    loadB.mockImplementation(discovery.load);
    let setup: ReturnType<typeof resolveNativeSelection> | undefined;
    try {
      if (transition === "before") {
        await replacePublication();
      }
      setup = withPreparedModelRuntimePluginGenerationScope(
        lease.pluginGeneration,
        () =>
          resolveNativeSelection(input, lease, b, () => {
            if (!runCurrent) {
              throw new Error("Native selection run authority revoked");
            }
          }),
        () => (leaseOpen ? lease.snapshot : undefined),
      );
      await Promise.race([
        discovery.entered,
        setup.then(() => {
          throw new Error("Native model setup completed before selected discovery");
        }),
      ]);
      if (transition === "during") {
        await replacePublication();
      } else if (transition === "revoked") {
        runCurrent = false;
      }
      const published = getPreparedModelRuntimeSnapshot(input)!;
      discovery.release();
      if (transition === "revoked") {
        await expect(setup).rejects.toThrow("Native selection run authority revoked");
      } else {
        expectNativeSetup(await setup, b);
        expect(getPreparedModelRuntimeSnapshot(input)).toBe(published);
        expectMissing(published.readFullModelCatalog?.()?.entries ?? [], b);
        await expect(owner.loadNativeModelCatalog!(nativeSelection(b))).rejects.toThrow(
          "superseded",
        );
      }
    } finally {
      discovery.release();
      await Promise.allSettled([setup]);
      leaseOpen = false;
    }
  },
);

it.each([false, true])(
  "carries a cold native selection into a stable run lease (standalone=%s)",
  async (standalone) => {
    const { input, owner, b, loadA, loadB } = await fixture(standalone, true);
    expect(loadA).not.toHaveBeenCalled();
    expect(loadB).not.toHaveBeenCalled();
    const selected = {
      ...input,
      workspaceDir: owner.workspaceDir,
      runtimePluginSelections: [{ ...nativeSelection(b), agentId: "pro" }],
    };
    await using lease = await acquireAgentRunPreparedModelRuntime(selected, {
      catalogMode: "static",
    });
    expectNativeSetup(await resolveNativeSelection(input, lease, b), b);
    expect(loadB).toHaveBeenCalledOnce();
    if (standalone) {
      expect(loadA).not.toHaveBeenCalled();
    }
    await using reused = await acquireAgentRunPreparedModelRuntime(selected, {
      catalogMode: "static",
    });
    expectModels(reused.snapshot.modelCatalog.entries, b);
    expect(loadB).toHaveBeenCalledOnce();
  },
);

it("does not share a failed pending native discovery with another runtime, and recovers explicitly", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true);
  const failure = new Error("Native A unavailable");
  const discovery = holdDiscovery(() => {
    throw failure;
  });
  loadA.mockImplementation(discovery.load);
  const selected = { provider: b.provider, modelId: b.id };
  const first = owner.loadNativeModelCatalog!({ ...selected, runtime: a.nativeRuntime });
  const rejected = expect(first).rejects.toBe(failure);
  await discovery.entered;
  const second = owner.loadNativeModelCatalog!({ ...selected, runtime: b.nativeRuntime });
  discovery.release();
  await rejected;
  expectModels((await second).entries, b);
  const partial = await owner.loadFullModelCatalog!({ refresh: true });
  expect(partial).toMatchObject({ authoritative: false, refreshFailed: true });
  expectModels(partial.entries, b);
  const calls = loadB.mock.calls.length;
  expect(await owner.loadFullModelCatalog!()).toBe(partial);
  expect(loadB).toHaveBeenCalledTimes(calls);
  loadA.mockResolvedValue([a]);
  const recovered = await owner.loadFullModelCatalog!({ refresh: true });
  expectModels(recovered.entries, a, b);
  expect(recovered.authoritative).not.toBe(false);
  expect(recovered.refreshFailed).toBeUndefined();
});

it("keeps observed untagged models without restoring API rows deleted during native discovery", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true, true);
  const siblingHost = { provider: a.provider, id: "sibling-host", name: "Sibling host" };
  loadA.mockResolvedValue([siblingHost]);
  const hostModel = { provider: b.provider, id: b.id, name: "API model" };
  const previousApi = apiRoute(hostModel, "openai-completions", "old", 16_000);
  const removedApi = { ...previousApi, id: "removed-api" };
  setProviderCatalog([previousApi, removedApi]);
  await owner.loadFullModelCatalog!({ refresh: true });
  const harnessOnly = { provider: b.provider, id: "harness-only", name: "Harness-only model" };
  const alternateHost = {
    ...apiRoute(hostModel, "openai-chatgpt-responses", "account", 48_000),
    name: "Account route",
    params: { accountModel: "account-route-model" },
  };
  const discovery = holdDiscovery(() => [
    { provider: b.provider, id: b.id, name: "Observed host model" },
    alternateHost,
    harnessOnly,
  ]);
  loadB.mockImplementationOnce(discovery.load);
  const selected = owner.loadNativeModelCatalog!(nativeSelection(b, harnessOnly.id));
  try {
    await discovery.entered;
    const freshApi = apiRoute(previousApi, "openai-responses", "fresh", 32_000);
    setProviderCatalog([freshApi]);
    await renewProvider(owner, b.provider);
    const providerPublication = owner.readFullModelCatalog!()!;
    expectModels(providerPublication.routeVariants, freshApi);
    expectMissing(providerPublication.routeVariants, { id: removedApi.id });
    discovery.release();
    const catalog = await selected;
    expectModels(catalog.routeVariants, alternateHost);
    for (const entries of catalogLists(catalog)) {
      expectModels(entries, harnessOnly, { ...freshApi, name: "Observed host model" }, siblingHost);
      expectMissing(entries, { id: removedApi.id });
      expect(entries.some((entry) => entry.provider === b.provider && entry.nativeRuntime)).toBe(
        false,
      );
    }
    const nativeCalls = loadB.mock.calls.length;
    const latestApi = { ...freshApi, contextWindow: 64_000 };
    setProviderCatalog([latestApi]);
    await renewProvider(owner, b.provider);
    expect(loadB).toHaveBeenCalledTimes(nativeCalls);
    expectModels(owner.readFullModelCatalog!()?.routeVariants, alternateHost);
    for (const entries of catalogLists(owner.readFullModelCatalog!()!)) {
      expectModels(entries, harnessOnly, { ...latestApi, name: "Observed host model" });
      expectMissing(entries, { id: removedApi.id });
    }
    const selection = nativeSelection(b, harnessOnly.id);
    loadB.mockRejectedValueOnce(new Error("Host discovery unavailable"));
    await owner.loadNativeModelCatalog!(selection).catch(() => undefined);
    expectModels(owner.readFullModelCatalog!()?.entries, harnessOnly);
    loadB.mockResolvedValue([]);
    const cleared = await owner.loadNativeModelCatalog!(selection);
    for (const entries of catalogLists(cleared)) {
      expectMissing(entries, { id: harnessOnly.id });
      expectModels(entries, latestApi, siblingHost);
    }
    expect(cleared.refreshFailed).toBeUndefined();
    expectMissing(cleared.routeVariants, { baseUrl: alternateHost.baseUrl });
  } finally {
    discovery.release();
    await selected.catch(() => undefined);
  }
});

it("publishes fresh API models when every native harness fails during a full refresh", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true, true);
  const previousApi = { provider: "api-provider", id: "old-api", name: "Old API model" };
  const ready = { provider: previousApi.provider, status: "ready" } as const;
  setProviderCatalog([previousApi], [ready]);
  await owner.loadFullModelCatalog!({ refresh: true });
  const freshApi = { ...previousApi, id: "fresh-api", name: "Fresh API model" };
  setProviderCatalog([freshApi], [ready]);
  loadA.mockRejectedValue(new Error("Native A unavailable"));
  loadB.mockRejectedValue(new Error("Native B unavailable"));

  await owner.loadFullModelCatalog!({ refresh: true }).catch(() => undefined);

  const catalog = owner.readFullModelCatalog!()!;
  for (const entries of catalogLists(catalog)) {
    expectModels(entries, freshApi, a, b);
    expectMissing(entries, { id: previousApi.id });
  }
  expect(catalog).toMatchObject({
    authoritative: false,
    refreshFailed: true,
    providerOutcomes: expect.arrayContaining([ready]),
  });
  expect(catalog.pendingProviders).toBeUndefined();
});

it("keeps a newly selected native model when a queued full refresh partly fails", async () => {
  const { owner, a, b, loadA, loadB } = await fixture(true, true);
  await owner.loadFullModelCatalog!({ refresh: true });
  const updatedA = { ...a, id: "updated-a", name: "Updated A" };
  const updatedB = { ...b, id: "selected-b", name: "Selected B" };
  const discovery = holdDiscovery(() => [updatedB]);
  const providerCompleted = createDeferredCore();
  loadA.mockResolvedValue([updatedA]);
  loadB.mockImplementationOnce(discovery.load);
  loadB.mockRejectedValue(new Error("Native B unavailable during full refresh"));
  const selected = owner.loadNativeModelCatalog!(nativeSelection(updatedB));
  await discovery.entered;
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
    discovery.release();
    expectModels((await selected).entries, updatedB);
    const catalog = await refreshed;
    expect(catalog).toMatchObject({ authoritative: false, refreshFailed: true });
    for (const entries of catalogLists(catalog)) {
      expectModels(entries, updatedA, updatedB);
      expectMissing(entries, { provider: b.provider, id: b.id });
    }
  } finally {
    discovery.release();
    await Promise.allSettled([selected, refreshed]);
  }
});

it.each(["__proto__", "constructor"])(
  "preserves native auth rejection through provider renewals without a refresh error (%s)",
  async (runtimeA) => {
    const { owner, a, b, loadA, loadB } = await fixture(true, false, runtimeA);
    const api = { provider: "api-provider", id: "model", name: "API model" };
    setProviderCatalog([api], [{ provider: api.provider, status: "ready" }]);
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
    expect(partial.authoritative).toBe(false);
    expect(partial.refreshFailed).toBeUndefined();
    expect(partial.providerOutcomes).toContainEqual(failure);
    expectModels(partial.entries, a, updatedB);

    const nativeCalls = loadA.mock.calls.length;
    await renewProvider(owner, api.provider);
    const renewed = owner.readFullModelCatalog!()!;
    expect(loadA).toHaveBeenCalledTimes(nativeCalls);
    expect(renewed.authoritative).toBe(false);
    expect(renewed.refreshFailed).toBeUndefined();
    expect(renewed.providerOutcomes).toContainEqual(failure);
    expectModels(renewed.entries, updatedB);

    // An empty successful result also represents disabled or missing optional apps.
    loadA.mockResolvedValue({ entries: [] });
    const cleared = await owner.loadFullModelCatalog!({ refresh: true });
    expect(cleared.refreshFailed).toBeUndefined();
    expect(cleared.providerOutcomes?.some(({ provider }) => provider === a.provider)).toBe(false);
    expectMissing(cleared.entries, { provider: a.provider });
    expectModels(cleared.entries, updatedB);
  },
);

it("keeps API provider readiness independent of a failed native runtime for the same provider", async () => {
  const { owner, a, loadA } = await fixture(true);
  const api = { provider: a.provider, id: "api-model", name: "API model" };
  const ready = { provider: a.provider, status: "ready" } as const;
  setProviderCatalog([api], [ready]);
  loadA.mockResolvedValue({
    entries: [],
    outcomes: [{ provider: a.provider, status: "unavailable", rejectionScope: "catalog" }],
  });
  const partial = await owner.loadFullModelCatalog!({ refresh: true });
  expect(partial.refreshFailed).toBe(true);
  expect(partial.providerOutcomes?.filter(({ provider }) => provider === a.provider)).toEqual([
    ready,
  ]);
  expectModels(partial.entries, api);
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

    await expect(owner.loadNativeModelCatalog!(nativeSelection(b))).rejects.toThrow("superseded");
    expect(owner.isCurrent()).toBe(false);
    expect(loadB).toHaveBeenCalledTimes(calls);
  },
);

it("renews native observations without retaining harness-only host projections", async () => {
  const provider = "custom";
  const native = { provider, id: "native", name: "Native", nativeRuntime: "fixture-native" };
  const host = { provider, id: "host-only", name: "Host only" };
  const api = { provider, id: "api", name: "API" };
  const profile: OAuthCredential = {
    ...oauth(provider, 1_900_000_000_000),
    accountId: "fixture-account",
  };
  const setProfile = (value: typeof profile) => {
    mocks.preparedAuthStore = { version: 1, profiles: { "custom:default": value } };
    const { provider: _provider, accountId: _accountId, ...credential } = value;
    mocks.authStorage.getAll.mockReturnValue({ custom: credential });
  };
  setProfile(profile);
  const load = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => [native, host]);
  installHarnesses([native, load]);
  mocks.configuredAgentIds = ["default"];
  setProviderCatalog([api], [{ provider, status: "ready" }]);
  const input = runtimeFixture.agentInput("default", {
    agents: { defaults: { model: "custom/api" } },
  });
  const options = { gatewayLifecycle: true, catalogMode: "static" as const };
  await refreshPreparedModelRuntimeSnapshots(input.config, options);
  const original = await prepareModelRuntimeSnapshot(input);
  const initial = await original.loadFullModelCatalog!();
  expectModels(initial.entries, native, host, api);

  const held = holdDiscovery(() => [native, host]);
  load.mockImplementation(held.load);
  setProfile({ ...profile, access: "after", refresh: "after-refresh" });
  let discovery: Promise<unknown> | undefined;
  try {
    await refreshPreparedModelRuntimeSnapshots(input.config, options);
    const renewed = await prepareModelRuntimeSnapshot(input);
    discovery = renewed.loadNativeModelCatalog!();
    await held.entered;
    const pending = renewed.readFullModelCatalog!()!;
    expectModels(pending.entries, native, api);
    for (const entries of catalogLists(pending)) {
      expectMissing(entries, host);
    }
    held.release();
    await discovery;
    expectModels(renewed.readFullModelCatalog!()!.entries, host);
  } finally {
    held.release();
    await discovery;
  }
});
