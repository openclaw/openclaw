import { expect, it, vi } from "vitest";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquireAgentRuntimePluginRegistry } from "./runtime-plugins.js";

const loader = vi.hoisted(() => ({ acquire: vi.fn() }));

vi.mock("../plugins/loader.js", () => ({
  acquirePluginRegistryForInspection: loader.acquire,
  loadPluginRegistryHandle: vi.fn(),
}));
vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => null,
  getActivePluginRegistryWorkspaceDir: () => undefined,
}));

it.each(["settled", "retained"] as const)(
  "keeps failed acquisition work reserved through %s cleanup failure",
  async (outcome) => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "acquisition-owner", status: "loaded" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const cleanupEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    const cleanupError =
      outcome === "retained"
        ? new AggregateError([
            new PluginRuntimeCloseRetainedError(new Error("host resource release is unfinished")),
          ])
        : new Error("host resources released with a cleanup warning");
    // The missing inspection owner rejects after acquisition. The loader still owns cleanup.
    loader.acquire.mockResolvedValueOnce({
      registry,
      release: () => {
        cleanupEntered.resolve();
        return cleanup.promise;
      },
    });
    const acquisition = acquireAgentRuntimePluginRegistry({
      config: { plugins: { enabled: false } },
    });
    const observed = acquisition.catch((error: unknown) => error);
    try {
      await cleanupEntered.promise;
      expect(() => instance.reserveReplacement()).toThrow("active retained work");
      cleanup.reject(cleanupError);
      expect(await observed).toMatchObject({
        message: "Prepared registry acquisition and cleanup failed",
        cause: cleanupError,
      });
      if (outcome === "retained") {
        expect(() => instance.reserveReplacement()).toThrow("active retained work");
      } else {
        instance.reserveReplacement()();
      }
    } finally {
      cleanup.reject(cleanupError);
      await observed;
      // This fixture has no prepared lifetime or physical resources; markers grant no custody.
      await instance.dispose();
    }
  },
);
