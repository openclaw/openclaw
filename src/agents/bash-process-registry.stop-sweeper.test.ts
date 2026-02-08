import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  markBackgrounded,
  resetProcessRegistryForTests,
  stopSweeper,
} from "./bash-process-registry.js";

describe("bash process registry sweeper stop", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it("exports stopSweeper function", () => {
    // Verify stopSweeper is exported and callable
    expect(typeof stopSweeper).toBe("function");
  });

  it("stopSweeper clears the sweeper interval", () => {
    // Spy on clearInterval
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    // Create a session that starts the sweeper
    const session: ProcessSession = {
      id: "sess-sweeper-test",
      command: "echo test",
      child: { pid: 123 } as ChildProcessWithoutNullStreams,
      startedAt: Date.now(),
      cwd: "/tmp",
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      aggregated: "",
      tail: "",
      exited: false,
      exitCode: undefined,
      exitSignal: undefined,
      truncated: false,
      backgrounded: false,
    };

    // Add session to start the sweeper
    addSession(session);
    markBackgrounded(session);

    // Stop the sweeper
    stopSweeper();

    // Verify clearInterval was called
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it("stopSweeper is idempotent (can be called multiple times safely)", () => {
    // Should not throw when called multiple times
    expect(() => {
      stopSweeper();
      stopSweeper();
      stopSweeper();
    }).not.toThrow();
  });
});
