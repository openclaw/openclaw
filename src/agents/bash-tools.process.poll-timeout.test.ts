import { afterEach, expect, test, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
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

test("process poll exposes adaptive retryInMs for repeated no-output polls", async () => {
  const processTool = createProcessTool();
  const sessionId = "sess-retry";
  const session = createBackgroundSession(sessionId);
  addSession(session);

  const poll1 = await processTool.execute("toolcall-1", {
    action: "poll",
    sessionId,
  });
  const poll2 = await processTool.execute("toolcall-2", {
    action: "poll",
    sessionId,
  });
  const poll3 = await processTool.execute("toolcall-3", {
    action: "poll",
    sessionId,
  });
  const poll4 = await processTool.execute("toolcall-4", {
    action: "poll",
    sessionId,
  });
  const poll5 = await processTool.execute("toolcall-5", {
    action: "poll",
    sessionId,
  });

  expect((poll1.details as { retryInMs?: number }).retryInMs).toBe(5000);
  expect((poll2.details as { retryInMs?: number }).retryInMs).toBe(10000);
  expect((poll3.details as { retryInMs?: number }).retryInMs).toBe(30000);
  expect((poll4.details as { retryInMs?: number }).retryInMs).toBe(60000);
  expect((poll5.details as { retryInMs?: number }).retryInMs).toBe(60000);
});

test("process poll resets retryInMs when output appears and clears on completion", async () => {
  const processTool = createProcessTool();
  const sessionId = "sess-reset";
  const session = createBackgroundSession(sessionId);
  addSession(session);

  const poll1 = await processTool.execute("toolcall-1", {
    action: "poll",
    sessionId,
  });
  const poll2 = await processTool.execute("toolcall-2", {
    action: "poll",
    sessionId,
  });
  expect((poll1.details as { retryInMs?: number }).retryInMs).toBe(5000);
  expect((poll2.details as { retryInMs?: number }).retryInMs).toBe(10000);

  appendOutput(session, "stdout", "step complete\n");
  const pollWithOutput = await processTool.execute("toolcall-output", {
    action: "poll",
    sessionId,
  });
  expect((pollWithOutput.details as { retryInMs?: number }).retryInMs).toBe(5000);

  markExited(session, 0, null, "completed");
  const pollCompleted = await processTool.execute("toolcall-completed", {
    action: "poll",
    sessionId,
  });
  const completedDetails = pollCompleted.details as { status?: string; retryInMs?: number };
  expect(completedDetails.status).toBe("completed");
  expect(completedDetails.retryInMs).toBeUndefined();

  const pollFinished = await processTool.execute("toolcall-finished", {
    action: "poll",
    sessionId,
  });
  const finishedDetails = pollFinished.details as { status?: string; retryInMs?: number };
  expect(finishedDetails.status).toBe("completed");
  expect(finishedDetails.retryInMs).toBeUndefined();
});
