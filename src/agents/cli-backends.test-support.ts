import { vi } from "vitest";
import * as runtimeBackends from "../plugins/cli-backends.runtime.js";
import * as setupRegistry from "../plugins/setup-registry.js";

type CliBackendsDeps = {
  resolvePluginSetupCliBackend: typeof import("../plugins/setup-registry.js").resolvePluginSetupCliBackend;
  resolvePluginSetupRegistry: typeof import("../plugins/setup-registry.js").resolvePluginSetupRegistry;
  resolveRuntimeCliBackends: typeof import("../plugins/cli-backends.runtime.js").resolveRuntimeCliBackends;
};

const restoreMocks: Array<() => void> = [];

function resetDepsForTest(): void {
  for (const restore of restoreMocks.splice(0)) {
    restore();
  }
}

export const testing = {
  resetDepsForTest,
  setDepsForTest(deps: Partial<CliBackendsDeps>): void {
    resetDepsForTest();
    if (deps.resolvePluginSetupCliBackend) {
      const spy = vi
        .spyOn(setupRegistry, "resolvePluginSetupCliBackend")
        .mockImplementation(deps.resolvePluginSetupCliBackend);
      restoreMocks.push(() => spy.mockRestore());
    }
    if (deps.resolvePluginSetupRegistry) {
      const spy = vi
        .spyOn(setupRegistry, "resolvePluginSetupRegistry")
        .mockImplementation(deps.resolvePluginSetupRegistry);
      restoreMocks.push(() => spy.mockRestore());
    }
    if (deps.resolveRuntimeCliBackends) {
      const spy = vi
        .spyOn(runtimeBackends, "resolveRuntimeCliBackends")
        .mockImplementation(deps.resolveRuntimeCliBackends);
      restoreMocks.push(() => spy.mockRestore());
    }
  },
};
