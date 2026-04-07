import { afterEach, beforeEach, expect, test, vi } from "vitest";

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;

const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

beforeEach(async () => {
  vi.resetModules();
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.js"));
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("disables future live exec updates when onUpdate throws", async () => {
  const tool = createExecTool(TEST_EXEC_DEFAULTS);
  const onUpdateSpy = vi.fn(() => {
    throw new Error("Agent listener invoked outside active run");
  });

  const result = await tool.execute(
    "toolcall",
    {
      command:
        'node -e \'process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 25); setTimeout(() => process.exit(0), 60)\'',
    },
    undefined,
    onUpdateSpy,
  );

  expect(result.details.status).toBe("completed");
  expect(onUpdateSpy).toHaveBeenCalledTimes(1);
});

test("disables live exec updates immediately when the tool aborts", async () => {
  const tool = createExecTool(TEST_EXEC_DEFAULTS);
  const abortController = new AbortController();
  const onUpdateSpy = vi.fn(() => {
    abortController.abort();
  });

  const result = await tool.execute(
    "toolcall",
    {
      command:
        'node -e \'process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 25); setTimeout(() => process.exit(0), 60)\'',
    },
    abortController.signal,
    onUpdateSpy,
  );

  expect(result.details.status).toBe("failed");
  expect(onUpdateSpy).toHaveBeenCalledTimes(1);
});
