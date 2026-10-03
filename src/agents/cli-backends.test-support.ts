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
      restoreMocks.push(
        vi
          .spyOn(setupRegistry, "resolvePluginSetupCliBackend")
          .mockImplementation(deps.resolvePluginSetupCliBackend).mockRestore,
      );
    }
    if (deps.resolvePluginSetupRegistry) {
      restoreMocks.push(
        vi
          .spyOn(setupRegistry, "resolvePluginSetupRegistry")
          .mockImplementation(deps.resolvePluginSetupRegistry).mockRestore,
      );
    }
    if (deps.resolveRuntimeCliBackends) {
      restoreMocks.push(
        vi
          .spyOn(runtimeBackends, "resolveRuntimeCliBackends")
          .mockImplementation(deps.resolveRuntimeCliBackends).mockRestore,
      );
    }
  },
};
