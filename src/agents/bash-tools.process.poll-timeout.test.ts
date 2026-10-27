import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  resetDiagnosticSessionStateForTest,
  type SessionState,
} from "../logging/diagnostic-session-state.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  getSession,
  markExited,
  recordNotifyOnExitRemoval,
  type ProcessSession,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";
import { isToolResultError } from "./tool-result-error.js";

const { cancel, killTree } = vi.hoisted(() => ({ cancel: vi.fn(), killTree: vi.fn() }));
// mock-isolation: Registry fixtures exercise cancellation decisions without launching processes.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ cancel }) }));
// mock-isolation: Synthetic process IDs must never reach the host process-killing implementation.
vi.mock("../process/kill-tree.js", () => ({ killProcessTree: killTree }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

function harness(overrides: Partial<ProcessSession> = {}) {
  const session = createProcessSessionFixture({
    id: "session",
    command: "test",
    backgrounded: true,
    ...overrides,
  });
  Object.assign(session, overrides);
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
function check(result: Result, details: object, includes: string[] = [], excludes: string[] = []) {
  expect(result.details).toMatchObject(details);
  for (const value of includes) {
    expect(text(result)).toContain(value);
  }
  for (const value of excludes) {
    expect(text(result)).not.toContain(value);
  }
}
const tick = () => vi.advanceTimersByTimeAsync(250);
function onExit(session: ProcessSession) {
  const remove = vi.fn(() => true);
  recordNotifyOnExitRemoval(session, remove);
  return remove;
}
function complete(session: ProcessSession, output: string, exitCode = 0) {
  appendOutput(session, "stdout", output);
  markExited(session, exitCode, null, "completed");
  return onExit(session);
}

function writableSession() {
  const stdin = {
    write: vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, done) => done?.(null)),
    end: vi.fn(),
    destroyed: false,
    writableEnded: false,
  };
  const { session } = harness({
    id: "input",
    command: "cat",
    startedAt: Date.now() - 20_000,
    stdin,
  });
  return { session, stdin };
}

const inputCall = (action: string, extra: Record<string, unknown> = {}) =>
  createProcessTool().execute(action, { action, sessionId: "input", ...extra });

test("does not close stdin when requester authority is revoked during a write", async () => {
  let current = true;
  const controller = new AbortController();
  const budget = createAgentToolExecutionBudget({
    signal: controller.signal,
    abort: (error) => controller.abort(error),
    isCurrent: () => current,
  });
  const { stdin } = writableSession();
  stdin.write.mockImplementation((_data, done) => {
    current = false;
    done?.(null);
  });
  await expect(
    budget.run(() => inputCall("write", { data: "allowed input", eof: true })),
  ).rejects.toThrow("execution scope is no longer active");
  expect(stdin.write).toHaveBeenCalledOnce();
  expect(stdin.end).not.toHaveBeenCalled();
});

test("exposes idle input controls only while stdin remains writable", async () => {
  const { session, stdin } = writableSession();
  appendOutput(session, "stdout", "Name? ");
  const details = {
    status: "running",
    sessionId: session.id,
    stdinWritable: true,
    waitingForInput: true,
    idleMs: 20_000,
    lastOutputAt: Date.now() - 20_000,
  };
  check(await inputCall("log"), details, ["may be waiting for input"]);
  await inputCall("poll");
  check(await inputCall("poll"), details, ["(no new output)", "may be waiting for input"]);
  check(await inputCall("list"), { sessions: [details] }, ["[input-wait]"]);
  expect(text(await inputCall("write", { data: "你好😀" }))).toBe(
    "Wrote 10 bytes to session input.",
  );
  stdin.writableEnded = true;
  check(
    await inputCall("log"),
    { status: "running", stdinWritable: false, waitingForInput: false },
    [],
    ["provide input"],
  );
  check(await inputCall("write", { data: "answer\n" }), { status: "failed" }, [
    "stdin is not writable",
  ]);
});

test.each(["poll", "log"])(
  "blocks repeated %s input waits despite elapsed time, then recognizes new output",
  async (action) => {
    const { session } = writableSession();
    const tool = createProcessTool();
    const params = { action, sessionId: session.id };
    const state: SessionState = { lastActivity: Date.now(), state: "processing", queueDepth: 0 };
    let sequence = 0;
    const observe = async () => {
      const toolCallId = `process-${sequence++}`;
      recordToolCall(state, "process", params, toolCallId);
      const result = await tool.execute(toolCallId, params);
      recordToolCallOutcome(state, { toolName: "process", toolParams: params, toolCallId, result });
      acknowledgeInternalToolResult(result);
      return result;
    };

    for (let index = 0; index < 20; index++) {
      vi.setSystemTime(Date.now() + 1_000);
      await observe();
    }
    expect(detectToolCallLoop(state, "process", params)).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "known_poll_no_progress",
      count: 20,
    });

    appendOutput(session, "stdout", "New prompt: ");
    check(await observe(), { idleMs: 40_000, lastOutputAt: session.startedAt }, ["New prompt:"]);
    expect(detectToolCallLoop(state, "process", params)).toEqual({ stuck: false });
  },
);

test("sorts by start time then registration order across terminal transitions", async () => {
  const sessions = (
    [
      ["later", 3_000],
      ["oldest", 1_000],
      ["middle", 2_000],
      ["newest-tie", 2_000],
    ] as const
  ).map(([id, startedAt]) => harness({ id, startedAt }).session);
  const expected = ["later", "newest-tie", "middle", "oldest"];
  const expectOrder = async () => {
    const result = await inputCall("list");
    expect(result.details).toMatchObject({
      sessions: expected.map((sessionId) => ({ sessionId })),
    });
    expect(
      text(result)
        .split("\n")
        .map((line) => line.split(" ")[0]),
    ).toEqual(expected);
  };
  for (const session of sessions) {
    await expectOrder();
    markExited(session, 0, null, "completed");
  }
  await expectOrder();
});

test("poll returns a new interactive prompt before its wait expires", async () => {
  const { session, poll } = harness();
  let settled = false;
  const pending = poll(30_000).then((result) => {
    settled = true;
    return result;
  });
  appendOutput(session, "stderr", "interactive prompt\n");
  await tick();
  expect(settled).toBe(true);
  check(await pending, { status: "running", sessionId: session.id }, ["interactive prompt"]);
});

test("an already-aborted poll leaves buffered output unread", async () => {
  const { session, poll } = harness();
  appendOutput(session, "stdout", "interactive prompt\n");
  const controller = new AbortController();
  controller.abort();
  await expect(poll(30_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  check(await poll(), { status: "running", sessionId: session.id }, ["interactive prompt"]);
});

test("a waiting poll cannot adopt a same-id successor after removal", async () => {
  const { session, poll } = harness();
  const pending = poll(2_000);
  session.backgrounded = false;
  deleteSession(session.id);
  markExited(session, 0, null, "completed");
  const { session: successor } = harness();
  const remove = complete(successor, "successor output\n");
  await tick();
  const original = await pending;
  check(original, { status: "failed" });
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
  const originalRemove = complete(session, output);
  deleteSession(session.id);
  const { session: successor } = harness();
  const successorRemove = complete(successor, "successor output\n", 7);
  await tick();
  const original = await pending;
  check(
    original,
    { status: "completed", exitCode: 0, aggregated: output },
    ["[latest]", "omitted output is no longer available through action=log"],
    ["[earlier]", "successor output", "use action=log"],
  );
  expect(originalRemove).not.toHaveBeenCalled();
  acknowledgeInternalToolResult(original);
  expect(originalRemove).toHaveBeenCalledOnce();
  check(await call("log"), { status: "completed", exitCode: 7 }, ["successor output"]);
  expect(successorRemove).not.toHaveBeenCalled();
});

test("capped stream output stays ordered, compact, and frozen through terminal drains", async () => {
  const { session, poll, call } = harness();
  Object.assign(session, { maxOutputChars: 3_000, pendingMaxOutputChars: 1_000 });
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
  expect(session).toMatchObject({ totalOutputChars: 8_000, pendingOutput: "" });
  expect(text(await call("log"))).toBe(
    discarded + "oe".repeat(1_500) + "\n\nProcess exited with code 0.",
  );
});

test.each([
  [null, null, "failed", "manual-cancel", false, "unknown exit code"],
  [null, "SIGKILL", "failed", "no-output-timeout", true, "signal SIGKILL"],
  [null, "SIGTERM", "failed", "overall-timeout", true, "signal SIGTERM"],
] as const)(
  "preserves exit %s/%s as %s (%s) across waiting and retained observations",
  async (code, signal, status, reason, timedOut, label) => {
    const { session, poll, call } = harness();
    const pending = poll("1000");
    appendOutput(session, "stderr", "terminal output\n");
    const noOutputTimedOut = reason === "no-output-timeout";
    markExited(session, code, signal, status, reason, noOutputTimedOut);
    const remove = onExit(session);
    await tick();
    const raced = await pending;
    const details = {
      status,
      sessionId: session.id,
      exitCode: code ?? undefined,
      exitReason: reason,
      timedOut,
      noOutputTimedOut,
    };
    check(raced, { ...details, aggregated: "terminal output\n" }, [
      `Process exited with ${label}.`,
    ]);
    const listed = await call("list");
    expect(listed.details).toMatchObject({ sessions: [details] });
    expect(text(listed).includes(`[${reason}]`)).toBe(timedOut);
    const log = await call("log");
    check(log, details, ["terminal output"]);
    const warning = "Verify the resulting state before retrying";
    expect([raced, log].map((result) => text(result).includes(warning))).toEqual([
      timedOut,
      timedOut,
    ]);
    const retained = await poll();
    check(retained, details, [`Process exited with ${label}.`], ["terminal output"]);
    if (reason === "overall-timeout") {
      const killed = await call("kill");
      check(killed, details);
      expect(isToolResultError(killed)).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
    }
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

test("poll aborts while waiting for completion", async () => {
  const { poll } = harness();
  const controller = new AbortController();
  const pending = poll(30_000, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  await rejected;
});

function managedSession(managed = true) {
  const fixture = harness({ pid: 4242 });
  if (managed) {
    fixture.session.processActivity = {
      resultSettled: false,
      lastOutputAtMs: fixture.session.startedAt,
    };
  }
  return fixture;
}

test("remove hides a running session without releasing its active-process count", async () => {
  const { session, call } = managedSession();
  expect((await call("remove")).content[0]).toMatchObject({
    text: "Removed session session from the process list. Termination was requested but is not yet confirmed.",
  });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(session.id, "manual-cancel");
  expect(getSession(session.id)).toBeUndefined();
  expect(getFinishedSession(session.id)).toBeUndefined();
  expect(getActiveBackgroundExecSessionCount()).toBe(1);
  markExited(session, null, "SIGTERM", "failed", "manual-cancel");
  expect(getActiveBackgroundExecSessionCount()).toBe(0);
  expect(getFinishedSession(session.id)).toBeUndefined();
});

test("removes a retained completed session and its logs", async () => {
  const { session, call } = managedSession();
  markExited(session, 0, null, "completed");
  expect((await call("kill")).details).toMatchObject({ status: "completed", exitCode: 0 });
  expect(cancel).not.toHaveBeenCalled();
  expect((await call("remove")).details).toMatchObject({ status: "completed" });
  expect((await call("log")).details).toMatchObject({
    status: "failed",
    error: `No session found for ${session.id}`,
  });
  expect((await call("kill")).details).toMatchObject({
    status: "failed",
    error: `No active session found for ${session.id}`,
  });
});

test("keeps terminal observations scoped when a cleared process id is reused", async () => {
  const { session, call } = managedSession();
  const scopedCall = (scopeKey: string) =>
    createProcessTool({ scopeKey }).execute("kill", { action: "kill", sessionId: session.id });
  session.scopeKey = "owner";
  markExited(session, 0, null, "completed");
  expect((await scopedCall("other")).details).toMatchObject({ status: "failed" });
  await call("clear");
  const successor = managedSession().session;
  successor.scopeKey = "other";
  expect((await scopedCall("owner")).details).toMatchObject({ status: "failed" });
  expect(cancel).not.toHaveBeenCalled();
  expect((await scopedCall("other")).details).toMatchObject({
    cancellationRequested: true,
    terminationConfirmed: false,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(getSession(session.id)).toBe(successor);
});

test.each([
  ["kill", false],
  ["remove", false],
  ["kill", true],
  ["remove", true],
] as const)(
  "refuses %s without cancellation authority (finalizing=%s)",
  async (action, finalizing) => {
    const { session, call } = managedSession(finalizing);
    if (finalizing) {
      session.processActivity = { resultSettled: true, lastOutputAtMs: session.startedAt };
      session.finalizing = true;
    }
    const result = await call(action);
    expect(cancel).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    expect(getSession(session.id)?.exited).toBe(false);
    const message = finalizing ? "is finalizing" : "no active supervisor cancellation handle";
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(message) });
    expect(result.details).toMatchObject({ status: "failed" });
  },
);
