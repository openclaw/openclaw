import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  markExited,
  recordNotifyOnExitRemoval,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

function harness() {
  const session = createProcessSessionFixture({
    id: "session",
    command: "test",
    backgrounded: true,
  });
  addSession(session);
  const tool = createProcessTool();
  const call = (action: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    tool.execute(action, { action, sessionId: session.id, ...extra }, signal);
  return {
    session,
    call,
    poll: (timeout?: number | string, signal?: AbortSignal) => call("poll", { timeout }, signal),
  };
}

type Result = Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>;
const text = (result: Result) => (result.content[0]?.type === "text" ? result.content[0].text : "");

test("poll returns a new interactive prompt before its wait expires", async () => {
  const { session, poll } = harness();
  let settled = false;
  const pending = poll(30_000).then((result) => {
    settled = true;
    return result;
  });
  appendOutput(session, "stderr", "interactive prompt\n");
  await vi.advanceTimersByTimeAsync(250);
  expect(settled).toBe(true);
  const result = await pending;
  expect(result.details).toMatchObject({ status: "running", sessionId: session.id });
  expect(text(result)).toContain("interactive prompt");
});

test("an already-aborted poll leaves buffered output unread", async () => {
  const { session, poll } = harness();
  appendOutput(session, "stdout", "interactive prompt\n");
  const controller = new AbortController();
  controller.abort();
  await expect(poll(30_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(session.pendingOutput).toEqual([{ stream: "stdout", text: "interactive prompt\n" }]);
});

test("poll drains interleaved output in callback order across completion", async () => {
  const { session, poll } = harness();
  appendOutput(session, "stderr", "ERR-before\n");
  appendOutput(session, "stdout", "OUT-after\n");
  const running = await poll();
  expect(text(running)).toContain("ERR-before\nOUT-after");
  expect(running.details).toMatchObject({
    status: "running",
    aggregated: "ERR-before\nOUT-after\n",
  });
  const pending = poll("2000");
  const unread = `ERR-last\n${"x".repeat(2_001)}\nEND`;
  appendOutput(session, "stderr", unread);
  markExited(session, 0, null, "completed");
  await vi.advanceTimersByTimeAsync(250);
  const terminal = await pending;
  expect(text(terminal)).toContain(unread);
  expect(text(terminal)).not.toContain("ERR-before");
  expect(text(terminal)).not.toContain("OUT-after");
  expect(terminal.details).toMatchObject({
    status: "completed",
    aggregated: `ERR-before\nOUT-after\n${unread}`,
  });
  expect(text(await poll())).not.toContain(unread);
});

test("a waiting poll cannot adopt a same-id successor after removal", async () => {
  const { session, poll } = harness();
  const pending = poll(2_000);
  session.backgrounded = false;
  deleteSession(session.id);
  markExited(session, 0, null, "completed");
  const successor = createProcessSessionFixture({ id: session.id, backgrounded: true });
  addSession(successor);
  appendOutput(successor, "stdout", "successor output\n");
  markExited(successor, 0, null, "completed");
  const remove = vi.fn(() => true);
  recordNotifyOnExitRemoval(successor, remove);
  await vi.advanceTimersByTimeAsync(250);
  const original = await pending;
  expect(original.details).toMatchObject({ status: "failed" });
  expect(text(original)).toBe(`No session found for ${session.id}`);
  expect(remove).not.toHaveBeenCalled();
  const result = await poll();
  expect(result.details).toMatchObject({ status: "completed", aggregated: "successor output\n" });
  expect(remove).not.toHaveBeenCalled();
  acknowledgeInternalToolResult(result);
  expect(remove).toHaveBeenCalledOnce();
});

test("an evicted completion keeps its receipt without recommending successor logs", async () => {
  const { session, poll, call } = harness();
  const pending = poll(2_000);
  const output = `[earlier]${"x".repeat(30_000)}[latest]`;
  session.maxOutputChars = output.length;
  appendOutput(session, "stdout", output);
  markExited(session, 0, null, "completed");
  const originalRemove = vi.fn(() => true);
  recordNotifyOnExitRemoval(session, originalRemove);
  deleteSession(session.id);
  const successor = createProcessSessionFixture({ id: session.id, backgrounded: true });
  addSession(successor);
  appendOutput(successor, "stdout", "successor output\n");
  markExited(successor, 7, null, "completed");
  const successorRemove = vi.fn(() => true);
  recordNotifyOnExitRemoval(successor, successorRemove);
  await vi.advanceTimersByTimeAsync(250);
  const original = await pending;
  expect(original.details).toMatchObject({ status: "completed", exitCode: 0, aggregated: output });
  expect(text(original)).not.toContain("[earlier]");
  expect(text(original)).toContain("[latest]");
  expect(text(original)).not.toContain("successor output");
  expect(text(original)).not.toContain("use action=log");
  expect(text(original)).toContain("omitted output is no longer available through action=log");
  expect(originalRemove).not.toHaveBeenCalled();
  acknowledgeInternalToolResult(original);
  expect(originalRemove).toHaveBeenCalledOnce();
  const log = await call("log");
  expect(log.details).toMatchObject({ status: "completed", exitCode: 7 });
  expect(text(log)).toContain("successor output");
  expect(successorRemove).not.toHaveBeenCalled();
});

test("capped stream output stays ordered, compact, and frozen through terminal drains", async () => {
  const { session, poll, call } = harness();
  session.maxOutputChars = 3_000;
  session.pendingMaxOutputChars = 1_000;
  const appendChunks = () => {
    for (let index = 0; index < 2_000; index += 1) {
      appendOutput(session, "stdout", "o");
      appendOutput(session, "stderr", "e");
    }
  };
  const discarded =
    "[earlier output was discarded at the retention cap and cannot be recovered]\n\n";
  const omitted =
    "[earlier output is omitted from this poll; use action=log with offset and limit to inspect retained output]\n\n";
  appendChunks();
  expect(text(await call("log"))).toBe(discarded + "oe".repeat(1_500));
  expect(text(await poll(30_000))).toBe(
    discarded + omitted + "oe".repeat(1_000) + "\n\nProcess still running.",
  );
  expect(text(await poll())).not.toContain("earlier output is omitted");
  appendChunks();
  markExited(session, 0, null, "completed");
  expect(session.pendingOutput).toBe("oe".repeat(1_000));
  expect(text(await poll())).toBe(
    discarded + omitted + "oe".repeat(1_000) + "\n\nProcess exited with code 0.",
  );
  appendOutput(session, "stderr", "late".repeat(1_000));
  expect(text(await poll())).toBe(discarded + "(no new output)\n\nProcess exited with code 0.");
  expect(session.totalOutputChars).toBe(8_000);
  expect(session.pendingOutput).toBe("");
  expect(text(await call("log"))).toBe(discarded + "oe".repeat(1_500));
});

test.each([
  [7, null, "completed", "exit", false, "code 7"],
  [null, null, "failed", "manual-cancel", false, "unknown exit code"],
  [0, null, "failed", "overall-timeout", true, "code 0"],
  [null, "SIGKILL", "failed", "no-output-timeout", true, "signal SIGKILL"],
] as const)(
  "preserves exit %s/%s as %s (%s) across waiting and retained observations",
  async (code, signal, status, reason, timedOut, label) => {
    const { session, poll, call } = harness();
    const pending = poll(1_000);
    appendOutput(session, "stderr", "terminal output\n");
    const noOutputTimedOut = reason === "no-output-timeout";
    markExited(session, code, signal, status, reason, noOutputTimedOut);
    const remove = vi.fn(() => true);
    recordNotifyOnExitRemoval(session, remove);
    await vi.advanceTimersByTimeAsync(250);
    const raced = await pending;
    const details = {
      status,
      sessionId: session.id,
      exitCode: code ?? undefined,
      exitReason: reason,
      timedOut,
      noOutputTimedOut,
    };
    expect(raced.details).toMatchObject({ ...details, aggregated: "terminal output\n" });
    expect(text(raced)).toContain(`Process exited with ${label}.`);
    expect(text(raced).includes("Verify the resulting state before retrying")).toBe(timedOut);
    const listed = await call("list");
    expect(listed.details).toMatchObject({ sessions: [details] });
    expect(text(listed).includes(`[${reason}]`)).toBe(timedOut);
    const log = await call("log");
    expect(log.details).toMatchObject(details);
    expect(text(log)).toContain("terminal output");
    expect(text(log).includes("Verify the resulting state before retrying")).toBe(timedOut);
    const retained = await poll();
    expect(retained.details).toMatchObject(details);
    expect(text(retained)).toContain(`Process exited with ${label}.`);
    expect(text(retained)).not.toContain("terminal output");
    expect(remove).not.toHaveBeenCalled();
    acknowledgeInternalToolResult(raced);
    expect(remove).toHaveBeenCalledOnce();
  },
);

test("poll rejects timeoutMs with a correction before consuming output", async () => {
  const { session, call, poll } = harness();
  appendOutput(session, "stdout", "ready\n");
  await expect(call("poll", { timeoutMs: 5_000 })).rejects.toThrow(
    'process parameter "timeoutMs" is unsupported; use "timeout" instead',
  );
  expect(text(await poll())).toContain("ready");
});

test("poll still tolerates unrelated model-added parameters", async () => {
  const { call } = harness();
  expect((await call("poll", { description: "model-added explanation" })).details).toMatchObject({
    status: "running",
  });
});

test("poll clamps a long wait to 30 seconds", async () => {
  const { poll } = harness();
  let settled = false;
  const pending = poll(120_000).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).details).toMatchObject({ status: "running" });
});

test("poll aborts while waiting for completion", async () => {
  const { poll } = harness();
  const controller = new AbortController();
  const pending = poll(30_000, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  await rejected;
});

test("poll backoff grows while idle, resets on output, and clears on completion", async () => {
  const { session, poll } = harness();
  for (const retryInMs of [5_000, 10_000, 30_000, 60_000, 60_000]) {
    expect((await poll()).details).toMatchObject({ retryInMs });
  }
  appendOutput(session, "stdout", "step complete\n");
  expect((await poll()).details).toMatchObject({ retryInMs: 5_000 });
  markExited(session, 0, null, "completed");
  const completed = await poll();
  expect(completed.details).toMatchObject({ status: "completed" });
  expect(completed.details).not.toHaveProperty("retryInMs");
  expect((await poll()).details).not.toHaveProperty("retryInMs");
});
