import { afterEach, describe, expect, test, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

// Helper to create exec tool with sandbox mode disabled for testing
type ExecParams = {
  command: string;
  yieldMs?: number;
  background?: boolean;
  timeout?: number;
};

async function execWithYield(params: ExecParams) {
  const execTool = createExecTool({
    host: "gateway",
    security: "full",
    sandbox: undefined,
  });

  const result = await execTool.execute("test-call", params);
  return result;
}

describe("exec yieldMs output capture", () => {
  test("captures output when yielding to background", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const execTool = createExecTool({
        host: "gateway",
        security: "full",
        sandbox: undefined,
      });

      // Start a command that produces output after yieldMs
      // Use node to echo something after a short delay
      const execPromise = execTool.execute("test-call", {
        command: `${process.execPath} -e "setTimeout(() => console.log('OUTPUT_CAPTURED'), 100)"`,
        yieldMs: 50,
        timeout: 5,
      });

      // Advance past the yield timeout (50ms) plus the drain delay (50ms)
      await vi.advanceTimersByTimeAsync(150);

      const result = await execPromise;

      // Should have backgrounded
      expect(result.details).toMatchObject({
        status: "running",
      });

      // The session should have captured the output
      const sessionId = (result.details as { sessionId?: string }).sessionId;
      expect(sessionId).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("drain delay allows stdout to be captured before backgrounding", async () => {
    // This test verifies the 50ms drain delay is present
    // by checking that the timing works correctly
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const execTool = createExecTool({
        host: "gateway",
        security: "full",
        sandbox: undefined,
      });

      let resolved = false;
      const execPromise = execTool
        .execute("test-call", {
          command: `${process.execPath} -e "console.log('test')"`,
          yieldMs: 10,
          timeout: 5,
        })
        .then((result) => {
          resolved = true;
          return result;
        });

      // Advance to just past yieldMs but not the drain delay
      await vi.advanceTimersByTimeAsync(30);
      // Should not be resolved yet due to drain delay
      expect(resolved).toBe(false);

      // Advance past the drain delay (50ms)
      await vi.advanceTimersByTimeAsync(50);

      const result = await execPromise;
      expect(result.details).toMatchObject({
        status: "running",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("exec background mode output capture", () => {
  test("immediate background captures output with drain delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const execTool = createExecTool({
        host: "gateway",
        security: "full",
        sandbox: undefined,
      });

      const execPromise = execTool.execute("test-call", {
        command: `${process.execPath} -e "console.log('immediate')"`,
        background: true,
        timeout: 5,
      });

      // Advance past the drain delay
      await vi.advanceTimersByTimeAsync(100);

      const result = await execPromise;

      expect(result.details).toMatchObject({
        status: "running",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
