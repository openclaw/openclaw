import { afterEach, describe, expect, it } from "vitest";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createInspectionFixture } from "../plugins/registry-inspection.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

/**
 * Test for Finding A: Registration resource transfer gap
 *
 * Plugin registration resources (disposers) are tracked separately from instance ownership.
 * When an instance is transferred to a successor via `transferPluginInstanceOwner`,
 * its registration resources should not be disposed by the predecessor's cleanup.
 */
describe("registration resource transfer with instance ownership", () => {
  it("does NOT dispose registration resources when instance has been transferred away", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();

    // Create a plugin that registers a real disposer (e.g., closes a database connection)
    let disposerCalled = false;

    // We'll need to hook into the plugin's registration process
    // For this test, we'll use the existing fixture which already has a plugin
    // We'll track disposer calls through the fixture's connection

    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;

    try {
      // Load predecessor generation
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // The fixture's connection should have registered disposers during plugin load
      // We'll verify the disposer hasn't been called yet
      expect(fixture.connection(0).disposals).toBe(0);

      // Load successor generation, reusing predecessor registry
      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
        transferInstanceOwnership: true,
      });
      const successorRecord = successor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(getPluginInstance(successorRecord!)).toBe(instance);

      // Now release the predecessor's physical claim
      const releasePredecessor = retainPreparedPluginRegistry(predecessor.registry);
      await releasePredecessor?.();
      await predecessor.release();
      predecessor = undefined;

      // The instance should still be alive (ownership transferred)
      expect(instance!.disposing).toBe(false);

      // The real disposer should NOT have been called yet
      // When Finding A is fixed, the predecessor's cleanup should skip disposers
      // for transferred instances
      expect(fixture.connection(0).disposals).toBe(0);

      // Now release the successor
      await successor.release();
      successor = undefined;

      // Now the disposer should be called exactly once
      expect(fixture.connection(0).disposals).toBe(1);
    } finally {
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });

  it("disposes registration resources when instance has NOT been transferred", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();

    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;

    try {
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      const record = inspection.registry.plugins.find((entry) => entry.id === fixture.plugin.id);
      const instance = getPluginInstance(record!);
      expect(instance).toBeDefined();

      // Release the inspection (no successor)
      const release = retainPreparedPluginRegistry(inspection.registry);
      await release?.();
      await inspection.release();
      inspection = undefined;

      // The disposer should be called (instance wasn't transferred)
      expect(fixture.connection(0).disposals).toBe(1);
    } finally {
      await fixture.cleanup(inspection);
    }
  });
});
