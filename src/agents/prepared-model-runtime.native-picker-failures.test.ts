// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  await resetPreparedModelRuntimeHarness(state);
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("native picker acquisition failures", () => {
  async function prepareNativePickerOwner() {
    const { resolveAgentEffectiveModelPrimary } =
      await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    mocks.resolveAgentEffectiveModelPrimary.mockImplementation(resolveAgentEffectiveModelPrimary);
    const nativeDefault = {
      provider: "provider-a",
      id: "model",
      name: "Native default",
      nativeRuntime: "native-default",
    };
    const nativeAlternative = {
      provider: "provider-b",
      id: "model",
      name: "Native alternative",
      nativeRuntime: "native-alternative",
    };
    const loadDefault = vi.fn(async () => [nativeDefault]);
    const loadAlternative = vi.fn(async () => [nativeAlternative]);
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      for (const [id, loadModelCatalog] of [
        ["native-default", loadDefault],
        ["native-alternative", loadAlternative],
      ] as const) {
        registry.agentHarnesses.push({
          pluginId: id,
          source: "fixture",
          harness: {
            id,
            label: id,
            supports: () => ({ supported: true }),
            async runAttempt() {
              throw new Error("catalog-only fixture");
            },
            loadModelCatalog,
          },
        });
      }
      return registry;
    });
    const config: OpenClawConfig = {
      agents: {
        entries: { pro: {} },
        defaults: {
          model: "provider-a/model",
          models: {
            "provider-a/model": { agentRuntime: { id: "native-default" } },
            "provider-b/model": {
              agentRuntime: { id: "openclaw" },
              pickerRuntimes: ["native-alternative"],
            },
          },
        },
      },
    };
    const host = { provider: "provider-b", id: "model", name: "Host alternative" };
    const providerOutcomes = [
      { provider: "provider-a", status: "ready" as const },
      { provider: "provider-b", status: "ready" as const },
    ];
    mocks.configuredAgentIds = ["pro"];
    mocks.runPreparedModelCatalogWorker.mockImplementation(async (providerIds) => ({
      entries: !providerIds || providerIds.includes(host.provider) ? [host] : [],
      routeVariants: !providerIds || providerIds.includes(host.provider) ? [host] : [],
      providerOutcomes: providerOutcomes.filter(
        ({ provider }) => !providerIds || providerIds.includes(provider),
      ),
    }));
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const owner = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!;
    await owner.loadFullModelCatalog!({ refresh: true });
    const freshDefault = { ...nativeDefault, name: "Fresh native default" };
    loadDefault.mockResolvedValue([freshDefault]);
    return { owner, config, loadDefault, loadAlternative, freshDefault, providerOutcomes };
  }

  it("publishes useful native rows and retains failed scope until its explicit recovery", async () => {
    const { owner, loadDefault, loadAlternative, freshDefault, providerOutcomes } =
      await prepareNativePickerOwner();
    loadAlternative.mockRejectedValue(new Error("Alternative catalog unavailable"));
    const partial = await owner.loadFullModelCatalog!({ refresh: true });
    expect(partial.entries).toContainEqual(expect.objectContaining(freshDefault));
    expect(partial.routeVariants).toContainEqual(expect.objectContaining(freshDefault));
    expect(
      partial.providerOutcomes?.toSorted((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ).toEqual(providerOutcomes);
    expect(partial).toMatchObject({ authoritative: false, refreshFailed: true });
    const calls = [
      mocks.runPreparedModelCatalogWorker.mock.calls.length,
      loadDefault.mock.calls.length,
      loadAlternative.mock.calls.length,
    ];
    expect(await owner.loadFullModelCatalog!()).toBe(partial);
    expect(await owner.loadFullModelCatalog!()).toBe(partial);
    expect([
      mocks.runPreparedModelCatalogWorker.mock.calls.length,
      loadDefault.mock.calls.length,
      loadAlternative.mock.calls.length,
    ]).toEqual(calls);

    const inventoryOwner = resolvePreparedModelRuntimeOwnerBySnapshot(owner);
    for (const provider of ["provider-a", "provider-b"]) {
      const beforeRenewal = owner.readFullModelCatalog!();
      const facts = inventoryOwner?.catalogInventory?.providers.get(provider);
      if (!facts) {
        throw new Error(`Missing published inventory for ${provider}`);
      }
      const providerCalls = mocks.runPreparedModelCatalogWorker.mock.calls.length;
      facts.expiresAt = 0;
      owner.readFullModelCatalog!();
      await vi.waitFor(() => {
        expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls + 1);
        const published = owner.readFullModelCatalog!();
        expect(published).not.toBe(beforeRenewal);
        expect(published?.pendingProviders).toBeUndefined();
      });
      const renewed = owner.readFullModelCatalog!()!;
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenLastCalledWith([provider]);
      expect(loadDefault).toHaveBeenCalledTimes(calls[1]!);
      expect(loadAlternative).toHaveBeenCalledTimes(calls[2]!);
      expect(renewed.entries).toContainEqual(expect.objectContaining(freshDefault));
      expect(
        renewed.providerOutcomes?.toSorted((left, right) =>
          left.provider.localeCompare(right.provider),
        ),
      ).toEqual(providerOutcomes);
      expect.soft(renewed, `${provider} host renewal`).toMatchObject({
        authoritative: false,
        refreshFailed: true,
      });
    }

    const unrelated = await owner.loadFullModelCatalog!({
      refresh: true,
      providerIds: ["provider-a"],
    });
    expect(unrelated).toMatchObject({ authoritative: false, refreshFailed: true });
    expect(
      unrelated.providerOutcomes?.toSorted((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ).toEqual(providerOutcomes);
    expect(loadAlternative).toHaveBeenCalledTimes(calls[2]!);
    const recoveredAlternative = {
      provider: "provider-b",
      id: "model",
      name: "Recovered native alternative",
      nativeRuntime: "native-alternative",
    };
    loadAlternative.mockResolvedValue([recoveredAlternative]);
    const recovered = await owner.loadFullModelCatalog!({
      refresh: true,
      providerIds: ["provider-b"],
    });
    expect(recovered.routeVariants).toContainEqual(expect.objectContaining(recoveredAlternative));
    expect(recovered.entries).toContainEqual(expect.objectContaining(freshDefault));
    expect(
      recovered.providerOutcomes?.toSorted((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ).toEqual(providerOutcomes);
    expect(recovered.authoritative).not.toBe(false);
    expect(recovered.refreshFailed).toBeUndefined();
  });

  it("rejects full native acquisition failure while retaining the published catalog", async () => {
    const { owner, loadDefault, loadAlternative } = await prepareNativePickerOwner();
    const failure = new Error("Default catalog unavailable");
    loadDefault.mockRejectedValue(failure);
    loadAlternative.mockRejectedValue(new Error("Alternative catalog unavailable"));
    await expect(owner.loadFullModelCatalog!({ refresh: true })).rejects.toBe(failure);
    expect(owner.isCurrent()).toBe(true);
    expect(owner.readFullModelCatalog!()).toMatchObject({
      authoritative: false,
      refreshFailed: true,
    });
  });

  it("does not publish partial native success after the owner is superseded", async () => {
    const { owner, config, loadAlternative, freshDefault } = await prepareNativePickerOwner();
    const started = createDeferredCore();
    const release = createDeferredCore();
    loadAlternative.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      throw new Error("Retired alternative catalog unavailable");
    });
    const refresh = owner.loadFullModelCatalog!({ refresh: true });
    const rejected = expect(refresh).rejects.toThrow("superseded");
    try {
      await started.promise;
      await refreshPreparedModelRuntimeSnapshots(
        {
          ...config,
          agents: {
            ...config.agents,
            defaults: { ...config.agents?.defaults, model: "provider-a/replacement" },
          },
        },
        { gatewayLifecycle: true, catalogMode: "static" },
      );
    } finally {
      release.resolve();
    }
    await rejected;
    expect(owner.isCurrent()).toBe(false);
    const replacement = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!;
    expect(replacement.modelCatalog.entries).not.toContainEqual(
      expect.objectContaining(freshDefault),
    );
  });
});
