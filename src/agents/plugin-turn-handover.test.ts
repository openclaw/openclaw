/** Verifies how held plugin work reacts when a reload reserves its plugins. */
import { describe, expect, it, vi } from "vitest";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "./plugin-runtime-refresh.js";
import { captureTurnHandoverRequest } from "./plugin-turn-handover.js";
import { retainRuntimePluginWork } from "./runtime-plugin-work.js";

function addPlugin(registry: PluginRegistry, id: string, turnHandover = false) {
  const record = createPluginRecord({ id });
  record.turnHandover = turnHandover || undefined;
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
}

function createRegistryWithInstance(id = "swap", turnHandover = false) {
  const registry = createEmptyPluginRegistry();
  return { registry, instance: addPlugin(registry, id, turnHandover) };
}

// Watchers and the handover decision each run on a microtask.
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("plugin turn handover", () => {
  it("tells held work when a reload reserves its plugin, and stops after release", () => {
    const { registry, instance } = createRegistryWithInstance();
    const requested = vi.fn();
    const release = retainRuntimePluginWork([registry], "unknown", requested);

    const done = instance.reserveReplacement();
    expect(requested).toHaveBeenCalledWith("swap", expect.any(Function));
    done();
    release();
    instance.reserveReplacement()();
    expect(requested).toHaveBeenCalledOnce();
  });

  it("tells work retained while a reload is already pending", async () => {
    const { registry, instance } = createRegistryWithInstance();
    instance.reserveReplacement();
    const requested = vi.fn();
    retainRuntimePluginWork([registry], "unknown", requested);

    await settle();
    expect(requested).toHaveBeenCalledWith("swap", expect.any(Function));
  });

  it("releases only the work count of a hold that yields", () => {
    const { registry, instance } = createRegistryWithInstance();
    retainRuntimePluginWork([registry], "unknown", (_pluginId, yieldHold) => yieldHold());
    expect(instance.retainedWorkCount).toBe(1);

    instance.reserveReplacement();
    expect(instance.retainedWorkCount).toBe(0);
  });

  it("keeps holds on plugins that do not declare turn handover", async () => {
    const { registry, instance } = createRegistryWithInstance();
    retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));

    instance.reserveReplacement();
    await settle();
    expect(instance.retainedWorkCount).toBe(1);
  });

  it("yields a whole-run hold outside a turn", async () => {
    const { registry, instance } = createRegistryWithInstance("swap", true);
    retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));

    instance.reserveReplacement();
    await settle();
    expect(instance.retainedWorkCount).toBe(0);
  });

  it("keeps every hold when one reloaded plugin can't hand over", async () => {
    const { registry, instance: swap } = createRegistryWithInstance("swap", true);
    const pinned = addPlugin(registry, "pinned");
    const refresh = createAgentPluginRuntimeRefresh();
    const control = refresh.run(() => {
      const captured = captureAgentPluginRuntimeRefresh();
      captured.bindConsumer(() => true);
      retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));
      return captured;
    });
    const outer = retainRuntimePluginWork(
      [registry],
      "unknown",
      captureTurnHandoverRequest([registry]),
    );

    // One reload reserves both plugins in a single pass.
    swap.reserveReplacement();
    pinned.reserveReplacement();
    await settle();

    expect(control.isRequested()).toBe(false);
    expect(swap.retainedWorkCount).toBe(2);
    expect(pinned.retainedWorkCount).toBe(2);
    outer();
  });

  it("asks a turn to hand over at its next step while its admitted calls still run", async () => {
    const { registry, instance } = createRegistryWithInstance("swap", true);
    const refresh = createAgentPluginRuntimeRefresh();
    const control = refresh.run(() => {
      // The attempt registers itself as the refresh consumer while it streams.
      const captured = captureAgentPluginRuntimeRefresh();
      captured.bindConsumer(() => true);
      retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));
      return captured;
    });

    instance.reserveReplacement();
    await settle();
    expect(control.isPending()).toBe(true);
    expect(control.requestSource()).toBe("reload");
    expect(instance.retainedWorkCount).toBe(1);
    // The reloading plugin keeps serving this generation until the step boundary.
    expect(() => control.assertCurrent()).not.toThrow();
  });

  it("lets the run's own tool request win the refresh source", async () => {
    const { registry, instance } = createRegistryWithInstance("swap", true);
    const refresh = createAgentPluginRuntimeRefresh();
    const control = refresh.run(() => {
      const captured = captureAgentPluginRuntimeRefresh();
      captured.bindConsumer(() => true);
      retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));
      return captured;
    });

    control.request();
    instance.reserveReplacement();
    await settle();
    expect(control.requestSource()).toBe("tool");
    expect(() => control.assertCurrent()).toThrow("Plugin runtime changed");
  });

  it("continues only a turn that actually stopped at a step boundary", async () => {
    const { registry, instance } = createRegistryWithInstance("swap", true);
    const refresh = createAgentPluginRuntimeRefresh();
    const control = refresh.run(() => {
      const captured = captureAgentPluginRuntimeRefresh();
      captured.bindConsumer(() => true);
      retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));
      return captured;
    });

    instance.reserveReplacement();
    await settle();
    // The reload landed during the final, tool-free model step: no boundary followed.
    expect(control.continuesAfterAttempt()).toBe(false);
    expect(control.stopAtStep()).toBe(true);
    expect(control.continuesAfterAttempt()).toBe(true);
  });

  it("drops a handover whose reload was cancelled before the next step", async () => {
    const { registry, instance } = createRegistryWithInstance("swap", true);
    const refresh = createAgentPluginRuntimeRefresh();
    const control = refresh.run(() => {
      const captured = captureAgentPluginRuntimeRefresh();
      captured.bindConsumer(() => true);
      retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest([registry]));
      return captured;
    });

    const cancel = instance.reserveReplacement();
    await settle();
    cancel();
    expect(control.stopAtStep()).toBe(false);
    expect(control.isRequested()).toBe(false);
    expect(control.continuesAfterAttempt()).toBe(false);
  });
});
