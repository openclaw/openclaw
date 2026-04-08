import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

describe("exec onUpdate error resilience", () => {
  test("does not crash when onUpdate throws after agent run ends", async () => {
    let callCount = 0;
    const throwingOnUpdate = () => {
      callCount++;
      if (callCount > 1) {
        // Simulate pi-agent-core throwing when the agent run has already ended
        throw new Error("Agent listener invoked outside active run");
      }
    };

    const tool = createExecTool(TEST_EXEC_DEFAULTS);
    // Run a command that produces multiple lines of output to trigger multiple onUpdate calls
    const command = 'node -e "for(let i=0; i<5; i++) { console.log(i); }"';

    // Should not throw — the error from onUpdate should be caught internally
    const result = await tool.execute("test-call-id", { command }, undefined, throwingOnUpdate);

    expect(result.details.status).toBe("completed");
    // onUpdate was called at least once, and subsequent calls that threw were swallowed
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test("suppresses subsequent updates after first error", async () => {
    const onUpdateSpy = vi.fn(() => {
      throw new Error("Agent listener invoked outside active run");
    });

    const tool = createExecTool(TEST_EXEC_DEFAULTS);
    const command = 'node -e "for(let i=0; i<5; i++) { console.log(i); }"';

    const result = await tool.execute("test-call-id", { command }, undefined, onUpdateSpy);

    expect(result.details.status).toBe("completed");
    // Should be called once, then suppressed
    expect(onUpdateSpy).toHaveBeenCalledTimes(1);
  });

  test("handles onUpdate errors in PTY mode", async () => {
    const throwingOnUpdate = vi.fn(() => {
      throw new Error("Agent listener invoked outside active run");
    });

    const tool = createExecTool(TEST_EXEC_DEFAULTS);
    const result = await tool.execute(
      "test-call-id",
      { command: "echo test", pty: true },
      undefined,
      throwingOnUpdate
    );

    expect(result.details.status).toBe("completed");
  });

  test("continues to call onUpdate when no errors occur", async () => {
    const onUpdateSpy = vi.fn();

    const tool = createExecTool(TEST_EXEC_DEFAULTS);
    const command = 'node -e "for(let i=0; i<3; i++) { console.log(i); }"';

    await tool.execute("test-call-id", { command }, undefined, onUpdateSpy);

    // Should be called multiple times without suppression
    expect(onUpdateSpy.mock.calls.length).toBeGreaterThan(1);
  });

  test("does not call onUpdate for backgrounded processes", async () => {
    const onUpdateSpy = vi.fn();

    const tool = createExecTool(TEST_EXEC_DEFAULTS);
    // Note: actual background behavior depends on platform
    const result = await tool.execute(
      "test-call-id",
      { command: "echo test", background: true },
      undefined,
      onUpdateSpy
    );

    // Backgrounded processes return immediately with "running" status
    expect(result.details.status).toBe("running");
    // onUpdate should not be called for backgrounded processes during initial execution
    expect(onUpdateSpy).not.toHaveBeenCalled();
  });
});
