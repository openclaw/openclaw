import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetDiagnosticSessionStateForTest,
  type SessionState,
} from "../logging/diagnostic-session-state.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import {
  addSession,
  appendOutput,
  markExited,
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

function writableSession() {
  const session = createProcessSessionFixture({
    id: "input",
    command: "cat",
    backgrounded: true,
    startedAt: Date.now() - 20_000,
  });
  const stdin = {
    write: vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, done) => done?.(null)),
    end: vi.fn(),
    destroyed: false,
    writableEnded: false,
  };
  session.stdin = stdin;
  addSession(session);
  return { session, stdin };
}
const call = (action: string, extra: Record<string, unknown> = {}) =>
  createProcessTool().execute(action, { action, sessionId: "input", ...extra });
type Result = Awaited<ReturnType<typeof call>>;
const text = (result: Result) => (result.content[0]?.type === "text" ? result.content[0].text : "");

it("does not close stdin when requester authority is revoked during a write", async () => {
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
    budget.run(() => call("write", { data: "allowed input", eof: true })),
  ).rejects.toThrow("execution scope is no longer active");
  expect(stdin.write).toHaveBeenCalledOnce();
  expect(stdin.end).not.toHaveBeenCalled();
});

it("exposes idle input controls only while stdin remains writable", async () => {
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
  const log = await call("log");
  expect(text(log)).toContain("may be waiting for input");
  expect(log.details).toMatchObject(details);
  await call("poll");
  const poll = await call("poll");
  expect(text(poll)).toContain("(no new output)");
  expect(text(poll)).toContain("may be waiting for input");
  expect(poll.details).toMatchObject(details);
  const listed = await call("list");
  expect(text(listed)).toContain("[input-wait]");
  expect(listed.details).toMatchObject({ sessions: [details] });
  stdin.writableEnded = true;
  const closed = await call("log");
  expect(text(closed)).not.toContain("provide input");
  expect(closed.details).toMatchObject({
    status: "running",
    stdinWritable: false,
    waitingForInput: false,
  });
  const write = await call("write", { data: "answer\n" });
  expect(text(write)).toContain("stdin is not writable");
  expect(write.details).toMatchObject({ status: "failed" });
});

it.each(["poll", "log"])(
  "blocks repeated %s input waits despite elapsed time, then recognizes new output",
  async (action) => {
    const { session } = writableSession();
    const tool = createProcessTool();
    const params = { action, sessionId: session.id };
    const state: SessionState = { lastActivity: Date.now(), state: "processing", queueDepth: 0 };
    const config = { enabled: true };
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
    expect(detectToolCallLoop(state, "process", params, config)).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "known_poll_no_progress",
      count: 20,
    });

    appendOutput(session, "stdout", "New prompt: ");
    const progressed = await observe();
    expect(text(progressed)).toContain("New prompt:");
    expect(progressed.details).toMatchObject({
      idleMs: 40_000,
      lastOutputAt: session.startedAt,
    });
    expect(detectToolCallLoop(state, "process", params, config)).toEqual({ stuck: false });
  },
);

it("reports UTF-8 byte counts for writes", async () => {
  writableSession();
  expect(text(await call("write", { data: "你好😀" }))).toBe("Wrote 10 bytes to session input.");
});

it("sorts by start time then registration order across terminal transitions", async () => {
  const sessions = (
    [
      ["later", 3_000],
      ["oldest", 1_000],
      ["middle", 2_000],
      ["newest-tie", 2_000],
    ] as const
  ).map(([id, startedAt]) => {
    const session = createProcessSessionFixture({ id, startedAt, backgrounded: true });
    addSession(session);
    return session;
  });
  const expected = ["later", "newest-tie", "middle", "oldest"];
  const expectOrder = async () => {
    const result = await call("list");
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
