/** PROTOTYPE (#182024): verifies how held plugin work reacts when a reload reserves its plugin. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "./plugin-runtime-refresh.js";
import { captureTurnHandoverRequest } from "./plugin-turn-handover.js";
import { retainRuntimePluginWork } from "./runtime-plugin-work.js";

function createRegistryWithInstance(id = "swap") {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  return { registry, instance: new PluginInstance(record.id, { record, registry }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("plugin turn handover", () => {
  it("tells held work when a reload reserves its plugin, and stops after release", () => {
    const { registry, instance } = createRegistryWithInstance();
    const requested = vi.fn(() => undefined);
    const release = retainRuntimePluginWork([registry], "unknown", requested);

    const settle = instance.reserveReplacement();
    expect(requested).toHaveBeenCalledWith("swap");
    settle();
    release();
    instance.reserveReplacement()();
    expect(requested).toHaveBeenCalledOnce();
  });

  it("tells work retained while a reload is already pending", async () => {
    const { registry, instance } = createRegistryWithInstance();
    instance.reserveReplacement();
    const requested = vi.fn(() => undefined);
    retainRuntimePluginWork([registry], "unknown", requested);

    await Promise.resolve();
    expect(requested).toHaveBeenCalledWith("swap");
  });

  it("releases only the work count of a hold that yields", () => {
    const { registry, instance } = createRegistryWithInstance();
    retainRuntimePluginWork([registry], "unknown", () => "yield");
    expect(instance.retainedWorkCount).toBe(1);

    instance.reserveReplacement();
    expect(instance.retainedWorkCount).toBe(0);
  });

  it("keeps holds on plugins that are not opted in", () => {
    vi.stubEnv("OPENCLAW_PLUGIN_TURN_HANDOVER", "other");
    const { registry, instance } = createRegistryWithInstance();
    retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest());

    instance.reserveReplacement();
    expect(instance.retainedWorkCount).toBe(1);
  });

  it("yields a whole-run hold outside a turn", () => {
    vi.stubEnv("OPENCLAW_PLUGIN_TURN_HANDOVER", "swap");
    const { registry, instance } = createRegistryWithInstance();
    retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest());

    instance.reserveReplacement();
    expect(instance.retainedWorkCount).toBe(0);
  });

  it("asks a turn to hand over at its next step while keeping its hold", () => {
    vi.stubEnv("OPENCLAW_PLUGIN_TURN_HANDOVER", "swap");
    const { registry, instance } = createRegistryWithInstance();
    const refresh = createAgentPluginRuntimeRefresh();
    const pending = refresh.run(() => {
      // The attempt registers itself as the refresh consumer while it streams.
      const control = captureAgentPluginRuntimeRefresh();
      control.bindConsumer(() => true);
      retainRuntimePluginWork([registry], "unknown", captureTurnHandoverRequest());
      instance.reserveReplacement();
      return control.isPending();
    });

    expect(pending).toBe(true);
    expect(instance.retainedWorkCount).toBe(1);
  });
});
