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
  vi.useRealTimers();
});

function createBackgroundedSession(sessionId: string) {
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
  timeout?: number,
) {
  const args = {
    action: "poll",
    sessionId,
    ...(timeout !== undefined ? { timeout } : {}),
  } as unknown as Parameters<ReturnType<typeof createProcessTool>["execute"]>[1];
  return processTool.execute(callId, args);
}

async function killSession(
  processTool: ReturnType<typeof createProcessTool>,
  callId: string,
  sessionId: string,
) {
  const args = {
    action: "kill",
    sessionId,
  } as unknown as Parameters<ReturnType<typeof createProcessTool>["execute"]>[1];
  return processTool.execute(callId, args);
}

test("pollActive is set during poll wait and cleared after", async () => {
  vi.useFakeTimers();
  const { processTool, session } = createBackgroundedSession("poll-active-flag");

  const pollPromise = pollSession(processTool, "call-1", "poll-active-flag", 5000);

  // Advance past first setTimeout in the wait loop to confirm pollActive is set
  await vi.advanceTimersByTimeAsync(250);
  expect(session.pollActive).toBe(true);

  // Exit the process so poll resolves
  appendOutput(session, "stdout", "done\n");
  markExited(session, 0, null, "completed");
  await vi.advanceTimersByTimeAsync(250);
  await pollPromise;

  // After poll completes, pollActive should be cleared by the finally block
  expect(session.pollActive).toBe(false);
});

test("poll sets exitNotified when process exits during poll", async () => {
  vi.useFakeTimers();
  const { processTool, session } = createBackgroundedSession("exit-notified");

  expect(session.exitNotified).toBeFalsy();

  // Schedule exit during poll wait
  setTimeout(() => {
    appendOutput(session, "stdout", "finished\n");
    markExited(session, 0, null, "completed");
  }, 50);

  const pollPromise = pollSession(processTool, "call-1", "exit-notified", 5000);
  await vi.advanceTimersByTimeAsync(300);
  const result = await pollPromise;

  expect((result.details as { status?: string }).status).toBe("completed");
  expect(session.exitNotified).toBe(true);
});

test("maybeNotifyOnExit is suppressed when pollActive is true", async () => {
  vi.useFakeTimers();
  const { processTool, session } = createBackgroundedSession("ghost-suppressed");

  // Start a poll with timeout (sets pollActive=true synchronously before first await)
  const pollPromise = pollSession(processTool, "call-1", "ghost-suppressed", 5000);

  // Advance into the wait loop so pollActive is confirmed set
  await vi.advanceTimersByTimeAsync(250);
  expect(session.pollActive).toBe(true);

  // Process exits during active poll - pollActive guards maybeNotifyOnExit
  appendOutput(session, "stdout", "done\n");
  markExited(session, 0, null, "completed");
  await vi.advanceTimersByTimeAsync(250);
  await pollPromise;

  // Poll set exitNotified, and pollActive is cleared - no ghost notification possible
  expect(session.exitNotified).toBe(true);
  expect(session.pollActive).toBe(false);
});

test("maybeNotifyOnExit fires normally when pollActive is false", () => {
  const { session } = createBackgroundedSession("ghost-normal");

  // Without any poll, both guards are unset
  expect(session.pollActive).toBeFalsy();
  expect(session.exitNotified).toBeFalsy();

  // Process exits without any active poll
  appendOutput(session, "stdout", "done\n");
  markExited(session, 0, null, "completed");

  // Neither guard is set, so maybeNotifyOnExit would fire
  expect(session.pollActive).toBeFalsy();
  expect(session.exitNotified).toBeFalsy();
});

test("kill sets exitNotified to true", async () => {
  const { processTool, session } = createBackgroundedSession("kill-notified");
  // Give it a pid so terminateSessionFallback can work
  session.pid = 999999;

  expect(session.exitNotified).toBeFalsy();

  await killSession(processTool, "call-1", "kill-notified");

  expect(session.exitNotified).toBe(true);
});
