import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import { createPluginRuntimeMock } from "../../test/helpers/plugins/plugin-runtime-mock.js";
import tasksPlugin from "./index.js";

describe("tasks plugin", () => {
  it("registers the default operations runtime, maintenance service, and CLI", () => {
    const registerOperationsRuntime = vi.fn();
    const registerService = vi.fn();
    const registerCli = vi.fn();

    tasksPlugin.register(
      createTestPluginApi({
        id: "tasks",
        name: "Tasks",
        source: "test",
        config: {},
        runtime: createPluginRuntimeMock(),
        registerOperationsRuntime,
        registerService,
        registerCli,
      }),
    );

    expect(registerOperationsRuntime).toHaveBeenCalledTimes(1);
    expect(registerService).toHaveBeenCalledTimes(1);
    expect(registerCli).toHaveBeenCalledTimes(1);
  });
});
