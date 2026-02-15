import { afterEach, expect, test, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  appendOutput,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

function createBackgroundSession(id: string): ProcessSession {
  return {
    id,
    command: "test",
    startedAt: Date.now(),
    cwd: "/tmp",
    maxOutputChars: 10_000,
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
    backgrounded: true,
  };
}

test("process poll waits for completion when timeout is provided", async () => {
  vi.useFakeTimers();
  try {
    const processTool = createProcessTool();
    const sessionId = "sess";
    const session = createBackgroundSession(sessionId);
    addSession(session);

    setTimeout(() => {
      appendOutput(session, "stdout", "done\n");
      markExited(session, 0, null, "completed");
    }, 10);

    const pollPromise = processTool.execute("toolcall", {
      action: "poll",
      sessionId,
      timeout: 2000,
    });

    let resolved = false;
    void pollPromise.finally(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    const poll = await pollPromise;
    const details = poll.details as { status?: string; aggregated?: string };
    expect(details.status).toBe("completed");
    expect(details.aggregated ?? "").toContain("done");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll accepts string timeout values", async () => {
  vi.useFakeTimers();
  try {
    const processTool = createProcessTool();
    const sessionId = "sess-2";
    const session = createBackgroundSession(sessionId);
    addSession(session);
    setTimeout(() => {
      appendOutput(session, "stdout", "done\n");
      markExited(session, 0, null, "completed");
    }, 10);

    const pollPromise = processTool.execute("toolcall", {
      action: "poll",
      sessionId,
      timeout: "2000",
    });
    await vi.advanceTimersByTimeAsync(350);
    const poll = await pollPromise;
    const details = poll.details as { status?: string; aggregated?: string };
    expect(details.status).toBe("completed");
    expect(details.aggregated ?? "").toContain("done");
  } finally {
    vi.useRealTimers();
  }
});
