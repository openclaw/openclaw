import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  markBackgrounded,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";

describe("bash process registry child.unref on background", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it("calls child.unref() when session is backgrounded", () => {
    const unrefSpy = vi.fn();

    const session: ProcessSession = {
      id: "sess-unref-test",
      command: "sleep 1000",
      child: {
        pid: 123,
        unref: unrefSpy,
      } as unknown as ChildProcessWithoutNullStreams,
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

    addSession(session);

    // Before backgrounding, unref should not have been called
    expect(unrefSpy).not.toHaveBeenCalled();

    // Background the session
    markBackgrounded(session);

    // Verify session is backgrounded
    expect(session.backgrounded).toBe(true);

    // Verify unref was called on the child
    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it("handles sessions without a child process gracefully", () => {
    const session: ProcessSession = {
      id: "sess-no-child",
      command: "echo test",
      child: undefined,
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

    addSession(session);

    // Should not throw when backgrounding a session without a child
    expect(() => markBackgrounded(session)).not.toThrow();
    expect(session.backgrounded).toBe(true);
  });

  it("handles child without unref method gracefully", () => {
    const session: ProcessSession = {
      id: "sess-no-unref",
      command: "echo test",
      child: {
        pid: 456,
        // No unref method
      } as unknown as ChildProcessWithoutNullStreams,
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

    addSession(session);

    // Should not throw when child doesn't have unref
    expect(() => markBackgrounded(session)).not.toThrow();
    expect(session.backgrounded).toBe(true);
  });
});
