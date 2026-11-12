import { expect, it } from "vitest";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createRuntimePluginWork,
  releaseRuntimePluginWork,
  retainDeferredRuntimePluginCapabilities,
} from "./runtime-plugin-work.js";

it("retains only resolved capabilities and keeps the admitted instance until physical cleanup", async () => {
  const registry = createEmptyPluginRegistry();
  const used = new PluginInstance("used");
  const unused = new PluginInstance("unused");
  const work = createRuntimePluginWork();
  const scope = new PluginInvocationScope(registry, [used, unused], { work });
  const callable = used.wrap(() => "old instance");
  const selected = scope.wrap(callable);
  expect(used.retainedWorkCount).toBe(1);
  expect(unused.retainedWorkCount).toBe(0);
  const unreserve = used.reserveReplacement();
  const cleanup = createDeferredCore();
  let idle = false;
  const waiting = used.waitForIdle(new AbortController().signal).then(() => {
    idle = true;
  });
  try {
    expect(selected()).toBe("old instance");
    expect(scope.run(() => selected())).toBe("old instance");
    expect(used.retainedWorkCount).toBe(1);
    const releasing = releaseRuntimePluginWork(() => cleanup.promise, work.release);
    await Promise.resolve();
    expect(idle).toBe(false);
    cleanup.resolve();
    await releasing;
    await waiting;
    expect(idle).toBe(true);
  } finally {
    cleanup.resolve();
    unreserve();
    scope.release();
    work.release();
    await Promise.all([used.dispose(), unused.dispose()]);
  }
});

it("propagates foreign same-ID invocation custody through nested scopes by object identity", async () => {
  const registry = createEmptyPluginRegistry();
  const local = new PluginInstance("same-id");
  const foreign = new PluginInstance("same-id");
  const work = createRuntimePluginWork();
  const parent = new PluginInvocationScope(registry, [local], { work });
  let child: PluginInvocationScope | undefined;
  try {
    parent.run(() => {
      child = new PluginInvocationScope(registry, []);
      child.run(() => {
        foreign.wrap(() => "foreign")();
        expect(pluginInvocationContext.getStore()?.retainedInstances).toEqual([foreign]);
      });
    });
    expect(foreign.retainedWorkCount).toBe(1);
    expect(local.retainedWorkCount).toBe(0);
    child!.release();
    expect(foreign.retainedWorkCount).toBe(1);
  } finally {
    child?.release();
    parent.release();
    work.release();
    await Promise.all([local.dispose(), foreign.dispose()]);
  }
});

it("retains delayed provider and hook capabilities but not unrelated tool factories", async () => {
  const registry = createEmptyPluginRegistry();
  const provider = new PluginInstance("provider");
  const hook = new PluginInstance("hook");
  const tool = new PluginInstance("tool");
  registry.providers.push({
    pluginId: "provider",
    source: "fixture",
    provider: provider.wrap({ id: "provider", label: "Provider", auth: [] }),
  });
  registry.typedHooks.push({
    pluginId: "hook",
    hookName: "agent_end",
    source: "fixture",
    handler: hook.wrap(async () => {}),
  });
  const work = createRuntimePluginWork();
  try {
    retainDeferredRuntimePluginCapabilities([registry], work);
    retainDeferredRuntimePluginCapabilities([registry], work);
    expect([provider.retainedWorkCount, hook.retainedWorkCount, tool.retainedWorkCount]).toEqual([
      1, 1, 0,
    ]);
  } finally {
    work.release();
    await Promise.all([provider.dispose(), hook.dispose(), tool.dispose()]);
  }
});

it("does not release exact work when physical cleanup remains retained", async () => {
  const instance = new PluginInstance("cleanup");
  const work = createRuntimePluginWork();
  work.retain(instance);
  const error = new PluginRuntimeCloseRetainedError(new Error("cleanup pending"));
  await expect(
    releaseRuntimePluginWork(async () => {
      throw error;
    }, work.release),
  ).rejects.toBe(error);
  expect(instance.retainedWorkCount).toBe(1);
  work.release();
  await instance.dispose();
});
