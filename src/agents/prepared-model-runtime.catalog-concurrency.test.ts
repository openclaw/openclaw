// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  AgentHarnessModelCatalogParams,
  AgentHarnessModelCatalogResult,
} from "./harness/types.js";
import { scopePreparedModelRuntimeLease } from "./prepared-model-runtime-generation-scope.js";
import {
  acquirePreparedModelRuntimeSnapshot,
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness({ label: "catalog-concurrency" });
const { mocks } = fixture;
const selection = { provider: "demo", modelId: "native-model", runtime: "native-test" };
const providerRow = { provider: "custom", id: "api-model", name: "API model" };
const providerCatalog = { entries: [providerRow], routeVariants: [providerRow] };

async function setup() {
  const agentIds = ["alpha", "beta", "gamma"];
  mocks.configuredAgentIds = agentIds;
  const config: OpenClawConfig = {
    agents: {
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      defaults: {
        model: "demo/native-model",
        models: { "demo/native-model": { agentRuntime: { id: "native-test" } } },
      },
    },
  };
  const observed = new Set<string>();
  const nativeRow = (agentDir: string) => ({
    provider: selection.provider,
    id: selection.modelId,
    nativeRuntime: selection.runtime,
    name: agentDir,
  });
  const loadNative = vi.fn<
    (params: AgentHarnessModelCatalogParams) => Promise<AgentHarnessModelCatalogResult>
  >(async ({ agentDir }) => {
    observed.add(agentDir);
    return [nativeRow(agentDir)];
  });
  mocks.resolveNativeModelPrimary.mockReturnValue("demo/native-model");
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: selection.runtime,
      source: "fixture",
      harness: {
        id: selection.runtime,
        label: "Native test",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog: loadNative,
        readModelCatalogReadiness: ({ agentDir }) =>
          observed.has(agentDir) ? { accountType: "apiKey" } : undefined,
      },
    });
    return registry;
  });
  mocks.runPreparedModelCatalogWorker.mockResolvedValue(providerCatalog);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const inputs = agentIds.map((id) => fixture.agentInput(id, config));
  const owners = inputs.map((input) => getPreparedModelRuntimeSnapshot(input)!);
  for (const owner of owners) {
    await owner.loadFullModelCatalog!({ changedOnly: true });
  }
  return { inputs, owners, observed, loadNative, nativeRow };
}

it.each(["selected", "full"] as const)(
  "bounds %s native discovery across owners while retaining owner-local results",
  async (entry) => {
    const { inputs, owners, observed, loadNative, nativeRow } = await setup();
    const started = owners.map(() => createDeferred());
    const release = owners.map(() => createDeferred());
    const entered: string[] = [];
    let active = 0;
    let maximum = 0;
    loadNative.mockImplementation(async ({ agentDir }) => {
      const index = inputs.findIndex((input) => input.agentDir === agentDir);
      entered.push(agentDir);
      maximum = Math.max(maximum, ++active);
      started[index]!.resolve();
      try {
        await release[index]!.promise;
        observed.add(agentDir);
        return [nativeRow(agentDir)];
      } finally {
        active--;
      }
    });
    const read = (index: number) =>
      entry === "selected"
        ? owners[index]!.loadNativeModelCatalog!(selection)
        : owners[index]!.loadFullModelCatalog!({ refresh: true, wait: true });
    const reads = [read(0)];
    try {
      await started[0]!.promise;
      reads.push(read(0), read(1), read(2));
      await nextTurn();
      expect(entered).toEqual([inputs[0]!.agentDir]);
      release[0]!.resolve();
      await started[1]!.promise;
      expect(entered).toEqual(inputs.slice(0, 2).map((input) => input.agentDir));
      release[1]!.resolve();
      await started[2]!.promise;
      release[2]!.resolve();
      const results = await Promise.all(reads);
      expect(maximum).toBe(1);
      expect(active).toBe(0);
      expect(loadNative).toHaveBeenCalledTimes(3);
      for (const [index, ownerIndex] of [0, 0, 1, 2].entries()) {
        expect(results[index]!.entries).toContainEqual(
          expect.objectContaining(nativeRow(inputs[ownerIndex]!.agentDir)),
        );
      }
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled(reads);
    }
  },
);

it.each(["native", "provider"] as const)(
  "keeps provider and native discovery independent when %s starts first, including warm reads",
  async (first) => {
    const { owners, loadNative } = await setup();
    await owners[2]!.loadNativeModelCatalog!(selection);
    const native = loadNative.getMockImplementation()!;
    const started = createDeferred();
    const release = createDeferred();
    const entered: string[] = [];
    const holdFirst = async (kind: string) => {
      entered.push(kind);
      if (kind === first) {
        started.resolve();
        await release.promise;
      }
    };
    loadNative.mockImplementation(async (params) => {
      await holdFirst("native");
      return await native(params);
    });
    mocks.runPreparedModelCatalogWorker.mockImplementation(async () => {
      await holdFirst("provider");
      const renewed = { ...providerRow, name: "Renewed API model" };
      return { entries: [renewed], routeVariants: [renewed] };
    });
    const renewProvider = async () => {
      const owner = owners[1]!;
      const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
      inventory.providers.get(providerRow.provider)!.expiresAt = 0;
      owner.refreshExpiredModelCatalog!();
      await vi.waitFor(() => {
        expect(owner.readFullModelCatalog!()!.entries).toContainEqual(
          expect.objectContaining({ name: "Renewed API model" }),
        );
      });
    };
    const read = (kind: string) =>
      kind === "native" ? owners[0]!.loadNativeModelCatalog!(selection) : renewProvider();
    const reads = [read(first)];
    try {
      await Promise.race([
        started.promise,
        reads[0]!.then(() => {
          throw new Error("Discovery did not start");
        }),
      ]);
      reads.push(read(first === "native" ? "provider" : "native"));
      await nextTurn();
      expect(entered).toEqual([first, first === "native" ? "provider" : "native"]);
      await reads[1];
      const warm = await owners[2]!.loadNativeModelCatalog!(selection);
      expect(warm.entries.some((entry) => entry.nativeRuntime === selection.runtime)).toBe(true);
      expect(entered).toEqual([first, first === "native" ? "provider" : "native"]);
      release.resolve();
      await Promise.all(reads);
      expect(entered).toEqual([first, first === "native" ? "provider" : "native"]);
    } finally {
      release.resolve();
      await Promise.allSettled(reads);
    }
  },
);

it("skips an owner retired while queued and continues after another owner's discovery fails", async () => {
  const { inputs, owners, loadNative } = await setup();
  const native = loadNative.getMockImplementation()!;
  const started = createDeferred();
  const release = createDeferred();
  const failure = new Error("Native discovery failed");
  loadNative.mockImplementation(async (params) => {
    if (params.agentDir === inputs[0]!.agentDir) {
      started.resolve();
      await release.promise;
      throw failure;
    }
    return await native(params);
  });
  const first = owners[0]!.loadNativeModelCatalog!(selection);
  const reads = [first];
  try {
    await started.promise;
    const replaced = owners[1]!.loadNativeModelCatalog!(selection);
    reads.push(replaced, owners[2]!.loadNativeModelCatalog!(selection));
    const settled = Promise.allSettled(reads);
    markPreparedModelRuntimeSnapshotsStale(undefined, { agentIds: new Set(["beta"]) });
    expect(owners[1]!.isCurrent()).toBe(false);
    await nextTurn();
    expect(loadNative).toHaveBeenCalledOnce();
    release.resolve();
    const results = await settled;
    expect(results[0]).toEqual({ status: "rejected", reason: failure });
    expect(results[1]).toEqual({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("superseded") }),
    });
    expect(results[2]!.status).toBe("fulfilled");
    expect(loadNative.mock.calls.map(([params]) => params.agentDir)).toEqual([
      inputs[0]!.agentDir,
      inputs[2]!.agentDir,
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled(reads);
  }
});

it.each([false, true])("rechecks queued borrow authority (closed=%s)", async (closed) => {
  const { inputs, owners, loadNative, nativeRow } = await setup();
  const lease = scopePreparedModelRuntimeLease(
    await acquirePreparedModelRuntimeSnapshot(inputs[1]!),
  );
  const native = loadNative.getMockImplementation()!;
  const started = createDeferred();
  const release = createDeferred();
  loadNative.mockImplementation(async (params) => {
    if (params.agentDir === inputs[0]!.agentDir) {
      started.resolve();
      await release.promise;
    }
    return await native(params);
  });
  const reads = [owners[0]!.loadNativeModelCatalog!(selection)];
  let disposal: Promise<void> | undefined;
  try {
    await started.promise;
    reads.push(lease.run(() => lease.snapshot.loadNativeModelCatalog!(selection)));
    const settled = Promise.allSettled(reads);
    await nextTurn();
    expect(loadNative).toHaveBeenCalledOnce();
    markPreparedModelRuntimeSnapshotsStale(undefined, { agentIds: new Set(["beta"]) });
    expect(owners[1]!.isCurrent()).toBe(false);
    if (closed) {
      disposal = lease[Symbol.asyncDispose]();
    }
    release.resolve();
    const results = await settled;
    expect(results[0]!.status).toBe("fulfilled");
    if (closed) {
      expect(results[1]).toMatchObject({ status: "rejected" });
      expect(loadNative).toHaveBeenCalledOnce();
    } else {
      expect(results[1]).toMatchObject({
        status: "fulfilled",
        value: {
          entries: expect.arrayContaining([
            expect.objectContaining(nativeRow(inputs[1]!.agentDir)),
          ]),
        },
      });
      expect(loadNative).toHaveBeenCalledTimes(2);
    }
  } finally {
    release.resolve();
    await Promise.allSettled(reads);
    await (disposal ?? lease[Symbol.asyncDispose]());
  }
});

it("retains the native slot after a foreground catalog wait expires", async () => {
  const { inputs, owners, loadNative } = await setup();
  const native = loadNative.getMockImplementation()!;
  const started = createDeferred();
  const release = createDeferred();
  loadNative.mockImplementation(async (params) => {
    if (params.agentDir === inputs[0]!.agentDir) {
      started.resolve();
      await release.promise;
    }
    return await native(params);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const foreground = owners[0]!.loadNativeModelCatalog!();
  const reads = [foreground];
  try {
    await started.promise;
    reads.push(owners[1]!.loadNativeModelCatalog!(selection));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await foreground).entries).not.toContainEqual(
      expect.objectContaining({ nativeRuntime: selection.runtime }),
    );
    expect(loadNative).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all(reads);
    await owners[0]!.loadNativeModelCatalog!(selection);
    expect(loadNative).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await Promise.allSettled(reads);
    vi.useRealTimers();
  }
});
