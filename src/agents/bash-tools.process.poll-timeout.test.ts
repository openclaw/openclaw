import { afterEach, expect, test, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
});

function createProcessSessionHarness(sessionId: string) {
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: "test",
    backgrounded: true,
  });
  addSession(session);
  return { processTool, session };
}

async function pollSession(
  processTool: ReturnType<typeof createProcessTool>,
  callId: string,
  sessionId: string,
  timeout?: number | string,
  signal?: AbortSignal,
) {
  const args = {
    action: "poll",
    sessionId,
    ...(timeout === undefined ? {} : { timeout }),
  } as unknown as Parameters<ReturnType<typeof createProcessTool>["execute"]>[1];
  return processTool.execute(callId, args, signal);
}

async function logSession(
  processTool: ReturnType<typeof createProcessTool>,
  callId: string,
  sessionId: string,
  params?: { offset?: number; limit?: number },
) {
  return processTool.execute(callId, {
    action: "log",
    sessionId,
    ...params,
  });
}

function retryMs(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { retryInMs?: number }).retryInMs;
}

function pollStatus(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { status?: string }).status;
}

async function expectCompletedPollWithTimeout(params: {
  sessionId: string;
  callId: string;
  timeout: number | string;
  advanceMs: number;
  assertUnresolvedAtMs?: number;
}) {
  vi.useFakeTimers();
  try {
    const { processTool, session } = createProcessSessionHarness(params.sessionId);

    setTimeout(() => {
      appendOutput(session, "stdout", "done\n");
      markExited(session, 0, null, "completed");
    }, 10);

    const pollPromise = pollSession(processTool, params.callId, params.sessionId, params.timeout);
    if (params.assertUnresolvedAtMs !== undefined) {
      let resolved = false;
      void pollPromise.finally(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(params.assertUnresolvedAtMs);
      expect(resolved).toBe(false);
    }

    await vi.advanceTimersByTimeAsync(params.advanceMs);
    const poll = await pollPromise;
    const details = poll.details as { status?: string; aggregated?: string };
    expect(details.status).toBe("completed");
    expect(details.aggregated ?? "").toContain("done");
  } finally {
    vi.useRealTimers();
  }
}

test("process poll waits for completion when timeout is provided", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess",
    callId: "toolcall",
    timeout: 2000,
    assertUnresolvedAtMs: 200,
    advanceMs: 100,
  });
});

test("process poll accepts string timeout values", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess-2",
    callId: "toolcall",
    timeout: "2000",
    advanceMs: 350,
  });
});

test("process poll returns unread output before entering a timed wait", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-timeout-pending";
    const { processTool, session } = createProcessSessionHarness(sessionId);
    appendOutput(session, "stdout", "ready\n");

    let resolved = false;
    const pollPromise = pollSession(processTool, "toolcall-timeout-pending", sessionId, 2000).then(
      (result) => {
        resolved = true;
        return result;
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    const poll = await pollPromise;
    const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";

    expect(pollStatus(poll)).toBe("running");
    expect(text).toContain("ready");
    expect(text).toContain("Process still running.");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll timed waits stop when the tool call is aborted", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-timeout-abort";
    const { processTool } = createProcessSessionHarness(sessionId);
    const controller = new AbortController();

    let resolved = false;
    const pollPromise = pollSession(
      processTool,
      "toolcall-timeout-abort",
      sessionId,
      2000,
      controller.signal,
    ).then((result) => {
      resolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(150);

    expect(resolved).toBe(true);
    const poll = await pollPromise;
    expect(pollStatus(poll)).toBe("running");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll exposes adaptive retryInMs for repeated no-output polls", async () => {
  const sessionId = "sess-retry";
  const { processTool } = createProcessSessionHarness(sessionId);

  const polls = await Promise.all([
    pollSession(processTool, "toolcall-1", sessionId),
    pollSession(processTool, "toolcall-2", sessionId),
    pollSession(processTool, "toolcall-3", sessionId),
    pollSession(processTool, "toolcall-4", sessionId),
    pollSession(processTool, "toolcall-5", sessionId),
  ]);

  expect(polls.map((poll) => retryMs(poll))).toEqual([5000, 10000, 30000, 60000, 60000]);
});

test("process poll resets retryInMs when output appears and clears on completion", async () => {
  const sessionId = "sess-reset";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  const poll1 = await pollSession(processTool, "toolcall-1", sessionId);
  const poll2 = await pollSession(processTool, "toolcall-2", sessionId);
  expect(retryMs(poll1)).toBe(5000);
  expect(retryMs(poll2)).toBe(10000);

  appendOutput(session, "stdout", "step complete\n");
  const pollWithOutput = await pollSession(processTool, "toolcall-output", sessionId);
  expect(retryMs(pollWithOutput)).toBe(5000);

  markExited(session, 0, null, "completed");
  const pollCompleted = await pollSession(processTool, "toolcall-completed", sessionId);
  expect(pollStatus(pollCompleted)).toBe("completed");
  expect(retryMs(pollCompleted)).toBeUndefined();

  const pollFinished = await pollSession(processTool, "toolcall-finished", sessionId);
  expect(pollStatus(pollFinished)).toBe("completed");
  expect(retryMs(pollFinished)).toBeUndefined();
});

test("process poll reports timeout exit reasons for finished sessions", async () => {
  const sessionId = "sess-timeout";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  markExited(session, null, null, "failed", "overall-timeout");

  const poll = await pollSession(processTool, "toolcall-timeout", sessionId);
  const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";
  expect(pollStatus(poll)).toBe("failed");
  expect(text).toContain("Process exited with timeout.");
  expect(text).not.toContain("code 0");
});

test("process poll includes timeout guidance when a waited poll observes exit", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-timeout-wait";
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const timeoutText =
      "Command timed out after 30 seconds. If this command is expected to take longer, re-run with a higher timeout.";

    setTimeout(() => {
      session.failureReason = timeoutText;
      markExited(session, null, "SIGKILL", "failed", "overall-timeout");
    }, 10);

    const pollPromise = pollSession(processTool, "toolcall-timeout-wait", sessionId, 2000);
    await vi.advanceTimersByTimeAsync(300);
    const poll = await pollPromise;
    const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";

    expect(pollStatus(poll)).toBe("failed");
    expect(text).toContain(timeoutText);
    expect(text).toContain("Process exited with timeout.");
    expect(text).not.toContain("code 0");
    expect((poll.details as { aggregated?: string }).aggregated).toBe("");
    expect((poll.details as { exitCode?: number | null }).exitCode).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("process poll preserves short output that appears in timeout guidance", async () => {
  const sessionId = "sess-timeout-short-output";
  const { processTool, session } = createProcessSessionHarness(sessionId);
  const timeoutText =
    "Command timed out after 30 seconds. If this command is expected to take longer, re-run with a higher timeout. Use timeout=0 only for local/sandbox/gateway execs.";

  appendOutput(session, "stdout", "0");
  session.failureReason = timeoutText;
  markExited(session, null, "SIGKILL", "failed", "overall-timeout");

  const poll = await pollSession(processTool, "toolcall-timeout-short-output", sessionId);
  const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";

  expect(text).toContain("0\n\nCommand timed out");
  expect(text).toContain("timeout=0");
});

test("process log includes timeout guidance for silent finished sessions", async () => {
  const sessionId = "sess-timeout-log";
  const { processTool, session } = createProcessSessionHarness(sessionId);
  const timeoutText =
    "Command timed out after 30 seconds. If this command is expected to take longer, re-run with a higher timeout.";

  session.failureReason = timeoutText;
  markExited(session, null, "SIGKILL", "failed", "overall-timeout");

  const log = await logSession(processTool, "toolcall-timeout-log", sessionId);
  const text = log.content[0]?.type === "text" ? log.content[0].text : "";

  expect(text).toContain(timeoutText);
  expect(text).not.toContain("(no output recorded)");
});

test("process log preserves raw slices for timed-out sessions with output", async () => {
  const sessionId = "sess-timeout-log-slice";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  appendOutput(session, "stdout", "first\nsecond\nthird\n");
  session.failureReason = "Command timed out after 30 seconds.";
  markExited(session, null, "SIGKILL", "failed", "overall-timeout");

  const log = await logSession(processTool, "toolcall-timeout-log-slice", sessionId, {
    offset: 1,
    limit: 1,
  });
  const text = log.content[0]?.type === "text" ? log.content[0].text : "";

  expect(text).toBe("second");
});
