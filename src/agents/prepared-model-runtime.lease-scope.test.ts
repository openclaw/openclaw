import { expect, it } from "vitest";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import { createPreparedModelRuntimeLease } from "./prepared-model-runtime.plugin-lifetime.js";
import { createRuntimePluginWork } from "./runtime-plugin-work.js";

it("keeps a prepared lease's own callback after its parent closes without inheriting sibling authority", async () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "lease-owned" });
  const instance = new PluginInstance(record.id, { record, registry });
  const sibling = new PluginInstance("parent-only");
  registry.tools.push({
    pluginId: record.id,
    source: "fixture",
    names: [],
    optional: false,
    factory: instance.wrap(() => null),
  });
  const parentWork = createRuntimePluginWork();
  const parent = new PluginInvocationScope(registry, [instance, sibling], { work: parentWork });
  const snapshot = createModelRuntimeChoiceOwnerFixture({}, () => true, {
    pluginRegistry: registry,
  });
  const generation = {
    pluginRegistry: registry,
    pluginMetadataSnapshot: snapshot.metadataSnapshot,
    remoteCatalog: null,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const lease = parent.run(() => createPreparedModelRuntimeLease(snapshot, generation));
  let calls = 0;
  const own = instance.wrap(() => ++calls);
  const unrelated = sibling.wrap(() => ++calls);
  const callback = () => lease.run!(() => own());
  try {
    parent.release();
    parentWork.release();
    expect(callback()).toBe(1);
    expect(instance.retainedWorkCount).toBe(1);
    expect(sibling.retainedWorkCount).toBe(0);
    expect(() => lease.run!(() => unrelated())).toThrow("Plugin invocation scope is closed");
    expect(calls).toBe(1);
    instance.quiesce();
    expect(callback).toThrow(PluginInstanceUnavailableError);
    instance.resume();
    expect(callback()).toBe(2);
    await instance.dispose();
    expect(instance.owner?.revoked).toBe(true);
    expect(callback).toThrow(PluginInstanceUnavailableError);
    await lease[Symbol.asyncDispose]();
    expect(callback).toThrow("Prepared model runtime lease is closed");
    expect(instance.retainedWorkCount).toBe(0);
    expect(sibling.retainedWorkCount).toBe(0);
    expect(calls).toBe(2);
  } finally {
    parent.release();
    parentWork.release();
    await lease[Symbol.asyncDispose]();
    await Promise.all([instance.dispose(), sibling.dispose()]);
  }
});
