import { createToolLoadContext } from "../plugins/tools.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryGatewayOwner,
  isPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { loadPreparedInboundPluginRegistry } from "./prepared-model-runtime.inbound-registry.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import * as runtimePlugins from "./runtime-plugins.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-registry-borrow" });
const { mocks } = fixture;

async function acquireBorrower(
  resources: AsyncDisposableStack,
  source: "owned" | "gateway" = "owned",
) {
  mocks.configuredAgentIds = ["default"];
  const config = {};
  const workspaceDir = "/tmp/unused-workspace";
  const metadata = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: makeRegistry([
      { id: "prepared-registry-borrow", origin: "config", channels: [] },
    ]),
  });
  const registry = createEmptyPluginRegistry();
  const manifest = metadata.plugins[0]!;
  const { id, rootDir, source: entrySource, origin } = manifest;
  const record = createPluginRecord({ id, rootDir, source: entrySource, origin });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  const input = {
    ...fixture.agentInput("default", config),
    workspaceDir,
    ...(source === "gateway" ? { allowGatewaySubagentBinding: true } : {}),
  };
  const runInScope = <T>(run: () => T) =>
    withPluginRuntimeRegistryScope(source === "gateway" ? registry : undefined, run);
  if (source === "gateway") {
    bindPluginRegistryGatewayOwner(registry, { current: () => registry });
    bindPluginRuntimeArtifactSelection(record, {
      runtimeEntry: resolvePluginRuntimeArtifactSelection({
        ...manifest,
        entryKind: "runtime",
        preferBuiltPluginArtifacts: false,
      }),
    });
    setPluginRuntimeLoadContext(
      registry,
      createToolLoadContext(config, workspaceDir, {
        metadataSnapshot: metadata,
        manifestRegistry: metadata.manifestRegistry,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      }),
    );
    setActivePluginRegistry(registry, undefined, "gateway-bindable", workspaceDir);
    resources.defer(() => clearActivePluginRegistry(registry));
    expect(runInScope(() => loadPreparedInboundPluginRegistry(input, metadata))).toBe(registry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  }
  const refresh = (catalogMode: "static" | "live" = "static") =>
    refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode,
      ...(source === "gateway"
        ? { allowGatewaySubagentBinding: true, pluginMetadataSnapshot: metadata }
        : {}),
    });
  return await runInScope(async () => {
    await refresh();
    const borrower = resources.use(await acquirePublishedPreparedModelRuntime(input));
    await borrower.snapshot.loadFullModelCatalog?.();
    return { registry, input, borrower, instance, refresh, runInScope };
  });
}

it("retires a prepared registry after its borrowing request scope has closed", async () => {
  const caller = new AsyncWorkScope();
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "late-catalog-lease", status: "loaded" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const entered = createDeferred();
  const finish = createDeferred();
  const cleaned = vi.fn();
  instance.lifecycle.onDispose(async () => {
    entered.resolve();
    await finish.promise;
    cleaned();
  });
  const borrower = await caller.track(() => {
    const release = retainPreparedPluginRegistry(registry);
    expect(release).toBeDefined();
    return { release: release!, run: AsyncLocalStorage.snapshot() };
  });
  await caller.drain();
  const retired = vi.fn();
  const closing = Promise.resolve(borrower.run(borrower.release)).then(retired);
  void closing.catch(() => {});
  try {
    await Promise.race([entered.promise, closing]);
    expect(retired).not.toHaveBeenCalled();
    finish.resolve();
    await closing;
    expect(cleaned).toHaveBeenCalledOnce();
    expect(retired).toHaveBeenCalledOnce();
    await expect(caller.track(() => undefined)).rejects.toThrow("Async work scope is closed");
    expect(() => instance.run(() => "retired")).toThrow("reloaded or disabled");
  } finally {
    finish.resolve();
    await closing.catch(() => {});
  }
});

it("rejects admission after construction closes", async () => {
  await using resources = new AsyncDisposableStack();
  const { registry, borrower, instance } = await acquireBorrower(resources);
  const construction = resources.use(
    new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry),
  );
  await borrower[Symbol.asyncDispose]();
  construction.retainRegistry(registry);
  expect(instance.retainedWorkCount).toBeGreaterThan(0);
  await construction[Symbol.asyncDispose]();
  expect(instance.retainedWorkCount).toBe(0);
  const released = "construction resources have been released";
  expect(() => construction.retainRegistry(registry)).toThrow(released);
  const loads = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
  await expect(construction.load({ config: {} }, () => {})).rejects.toThrow(released);
  expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(loads);
  markPreparedModelRuntimeSnapshotsStale("construction owner closed");
  expect(isPluginRegistryRetired(registry)).toBe(true);
});

it("retains selected inbound resources until a cancelled initial run inspection settles", async () => {
  await using resources = new AsyncDisposableStack();
  const { registry, input, borrower, instance } = await acquireBorrower(resources);
  const inspecting = createDeferred();
  const finishInspection = createDeferred();
  const acquire = runtimePlugins.acquireAgentRuntimePluginRegistry;
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(createEmptyPluginRegistry());
  const inspection = vi
    .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
    .mockImplementationOnce(async (...args) => {
      const acquired = await acquire(...args);
      inspecting.resolve();
      await finishInspection.promise;
      return acquired;
    });
  const pending = acquireAgentRunPreparedModelRuntime(
    {
      ...input,
      runtimePluginSelections: [{ provider: "custom", modelId: "selected", runtime: "openclaw" }],
    },
    { catalogMode: "static", pluginGeneration: borrower.pluginGeneration },
  ).then((lease) => resources.use(lease));
  const settled = Promise.allSettled([pending]);
  try {
    await awaitGateBeforeSettlement(
      inspecting.promise,
      pending,
      "Initial run skipped inspection acquisition",
    );
    markPreparedModelRuntimeSnapshotsStale("configuration replaced during run admission");
    await borrower[Symbol.asyncDispose]();
    expect(isPluginRegistryRetired(registry)).toBe(false);
    expect(instance.retainedWorkCount).toBeGreaterThan(0);
    finishInspection.resolve();
    await expect(pending).rejects.toThrow("superseded");
    await expect(pending).rejects.toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
    expect(isPluginRegistryRetired(registry)).toBe(true);
    expect(instance.retainedWorkCount).toBe(0);
  } finally {
    finishInspection.resolve();
    await settled;
    inspection.mockRestore();
  }
});

it("retains borrowed Gateway work through post-facts projection, then releases it", async () => {
  await using resources = new AsyncDisposableStack();
  const { registry, input, borrower, instance, refresh, runInScope } = await acquireBorrower(
    resources,
    "gateway",
  );
  const projecting = createDeferred();
  const finishProjection = createDeferred();
  mocks.buildPreparedModelCatalogSnapshot.mockImplementationOnce(async () => {
    projecting.resolve();
    await finishProjection.promise;
    return { entries: [], routeVariants: [] };
  });
  const pending = runInScope(async () => {
    await refresh("live");
    return await prepareModelRuntimeSnapshot(input);
  });
  const settled = Promise.allSettled([pending]);
  try {
    await awaitGateBeforeSettlement(
      projecting.promise,
      pending,
      "Preparation skipped live catalog projection",
    );
    await borrower[Symbol.asyncDispose]();
    expect(isPluginRegistryRetired(registry)).toBe(false);
    expect(instance.retainedWorkCount).toBeGreaterThan(0);
    finishProjection.resolve();
    const snapshot = await pending;
    expect(snapshot.pluginRegistry).toBe(registry);
    expect(isPluginRegistryRetired(registry)).toBe(false);
    expect(instance.retainedWorkCount).toBe(0);
  } finally {
    finishProjection.resolve();
    await settled;
  }
});
