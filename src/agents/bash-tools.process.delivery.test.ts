import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test, vi } from "vitest";
import { copyInternalToolResultState } from "../../packages/agent-core/src/internal-hooks.js";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { typeCheckSources } from "../../test/helpers/typescript.js";
import {
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginHookBeforeMessageWriteEvent } from "../plugins/types.js";
import {
  addSession,
  appendOutput,
  markExited,
  recordNotifyOnExitRemoval,
  type ProcessSession,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { createLazyProcessTool } from "./lazy-process-tool.js";
import type { AgentToolResult } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { getTextContent as resultText } from "./test-helpers/agent-tools-fs-helpers.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  resetGlobalHookRunner();
  await resetCodeModeTestState();
  resetProcessRegistryForTests();
});

function createSession(output = "", id = "process") {
  const session = createProcessSessionFixture({ id, backgrounded: true });
  addSession(session);
  if (output) {
    appendOutput(session, "stdout", output);
  }
  return session;
}

function toolTurn(id: string, name: string, args: Record<string, unknown>) {
  const toolCall = { type: "toolCall" as const, id, name, arguments: args };
  return {
    toolCall,
    assistantMessage: makeAgentAssistantMessage({ content: [toolCall], stopReason: "toolUse" }),
  };
}

function pollFixture(output = "") {
  const session = createSession(output);
  const tool = createProcessTool();
  const manager = SessionManager.inMemory();
  const guard = (options?: Parameters<typeof installSessionToolResultGuard>[1]) =>
    installSessionToolResultGuard(manager, options);
  const args = { action: "poll", sessionId: session.id };
  const turn = (id: string) => toolTurn(id, "process", args);
  const poll = (id: string, timeout?: number, context = turn(id)) =>
    runWithAgentToolExecutionContext(context, () =>
      tool.execute(id, { ...args, ...(timeout === undefined ? {} : { timeout }) }),
    );
  const persist = (id: string, result: AgentToolResult<unknown>) =>
    manager.appendMessage(
      copyInternalToolResultState(result, {
        role: "toolResult" as const,
        toolCallId: id,
        toolName: "process",
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: Date.now(),
      }),
    );
  const appendTurn = (id: string) => manager.appendMessage(turn(id).assistantMessage);
  return { session, manager, guard, turn, poll, persist, appendTurn };
}

function processCodeMode(lazy = false) {
  const h = createCodeModeHarness();
  const tool = lazy ? createLazyProcessTool() : createProcessTool();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
  return (code: string) =>
    runUntilCompleted({
      execTool: expectDefined(h.tools[0], "Code Mode exec"),
      waitTool: expectDefined(h.tools[1], "Code Mode wait"),
      code,
    });
}

const runProcessInCodeMode = (args: Record<string, unknown>) =>
  processCodeMode()(`return await process(${JSON.stringify(args)});`);

test("retains a waiting poll completion through failed persistence and acknowledges late receipts", async () => {
  vi.useFakeTimers();
  const h = pollFixture();
  const sessionKey = "agent:main:persist-notify";
  const eventOptions = { sessionKey, contextKey: `exec:${h.session.id}` };
  const unrelated = enqueueSystemEventEntry("unrelated", eventOptions);
  const recordCompletion = () =>
    recordNotifyOnExitRemoval(
      h.session,
      expectDefined(
        enqueueSystemEventWithReceipt("terminal output", eventOptions, { allowDuplicate: true }),
        "completion receipt",
      ),
    );
  const pending = h.poll("persist-notify", 1_000);
  appendOutput(h.session, "stdout", "terminal output");
  markExited(h.session, 0, null, "completed");
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(resultText(result)).toContain("terminal output");
  const append = vi.spyOn(h.manager, "appendMessageWithTranscriptAnchor");
  h.guard();
  h.appendTurn("persist-notify");
  append.mockImplementationOnce(() => {
    throw new Error("result persistence failed");
  });
  expect(() => h.persist("persist-notify", result)).toThrow("result persistence failed");
  recordCompletion();
  expect(peekSystemEventEntries(sessionKey)).toHaveLength(2);
  h.persist("persist-notify", result);
  expect(peekSystemEventEntries(sessionKey)).toEqual([unrelated]);
  expect(resultText(await h.poll("observed"))).not.toContain("terminal output");
  recordCompletion();
  expect(peekSystemEventEntries(sessionKey)).toEqual([unrelated]);
});

test("replays repaired poll output and consumes it after transformed persistence", async () => {
  const h = pollFixture("running-output\n");
  const guard = h.guard({
    runId: "transformed-run",
    maxToolResultChars: 16,
    transformMessageForPersistence: (message) => ({ ...message }),
    transformToolResultForPersistence: (message) => ({ ...message }),
    beforeMessageWriteHook: ({ message }) => ({ message: { ...message } }),
  });
  const dropped = snapshotToolSearchTargetTranscriptResult(await h.poll("dropped"));
  expect(resultText(dropped)).toContain("running-output");
  h.appendTurn("dropped");
  guard.flushPendingToolResults();
  const retry = snapshotToolSearchTargetTranscriptResult(await h.poll("retry"));
  expect(resultText(retry)).toContain("running-output");
  h.appendTurn("retry");
  h.persist("retry", retry);
  expect(resultText(await h.poll("observed"))).not.toContain("running-output");
});

test.each(["blocked", "error"] as const)(
  "preserves poll acknowledgement through %s nested activity persistence",
  async (mode) => {
    const session = createSession("nested-output\n", "nested-poll");
    if (mode === "error") {
      markExited(session, 1, null, "failed");
    }
    let writes = 0;
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "nested-poll-write",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
        if (message.role !== "custom") {
          return undefined;
        }
        writes += 1;
        return mode === "blocked" && writes === 1 ? { block: true } : { message: { ...message } };
      },
    });
    initializeGlobalHookRunner(registry);
    const h = createSubscribedCodeModeHarness({ name: "poll-persistence" });
    applyCodeModeCatalog({ ...h, tools: [...h.tools, createProcessTool()] });
    const execTool = expectDefined(h.tools[0], "Code Mode exec tool");
    const waitTool = expectDefined(h.tools[1], "Code Mode wait tool");
    const code = 'return await process({ action: "poll", sessionId: "nested-poll" });';
    const poll = (id: string) =>
      runWithAgentToolExecutionContext(toolTurn(id, execTool.name, { code }), async () =>
        waitUntilCompleted({
          details: resultDetails(await execTool.execute(id, { code })),
          waitTool,
        }),
      );
    const output = expect.objectContaining({
      type: "text",
      text: expect.stringContaining("nested-output"),
    });
    try {
      expect(await poll("nested-first")).toMatchObject({ status: "completed" });
      const firstActivities = await h.readNestedActivities();
      if (mode === "error") {
        expect(firstActivities).toHaveLength(1);
        expect(firstActivities[0]?.details.result.content).toContainEqual(output);
        expect(firstActivities[0]?.details.isError).toBe(true);
      } else {
        expect(firstActivities).toEqual([]);
      }
      expect(await poll("nested-next-turn")).toMatchObject({ status: "completed" });
      const nextActivities = await h.readNestedActivities();
      expect(nextActivities).toHaveLength(mode === "blocked" ? 1 : 2);
      if (mode === "blocked") {
        expect(nextActivities[0]?.details.result.content).toContainEqual(output);
        expect(await poll("nested-after-retry")).toMatchObject({ status: "completed" });
      }
      const settledActivities = await h.readNestedActivities();
      expect(settledActivities).toHaveLength(2);
      expect(settledActivities.at(-1)?.details.result.content).not.toContainEqual(output);
    } finally {
      h.dispose();
    }
  },
);

test("Code Mode pages retained logs after showing the default tail and continuation hint", async () => {
  const lines = Array.from({ length: 205 }, (_, index) => `line-${index}`);
  const session = createSession(lines.join("\n"));
  markExited(session, 0, null, "completed");
  expect(await runProcessInCodeMode({ action: "log", sessionId: session.id })).toMatchObject({
    status: "completed",
    value: {
      status: "completed",
      totalLines: 205,
      output: `${lines.slice(5).join("\n")}\n\n[showing last 200 of 205 lines; pass offset/limit to page]\n\nProcess exited with code 0.`,
    },
  });
  expect(
    await runProcessInCodeMode({ action: "log", sessionId: session.id, offset: 1, limit: 1 }),
  ).toMatchObject({
    status: "completed",
    value: {
      status: "completed",
      output: "line-1\n\nProcess exited with code 0.",
      totalLines: 205,
    },
  });
});

test.each([
  ["empty paste", { action: "paste", text: "", bracketed: false }, "No paste text provided."],
  [
    "unknown cursor mode",
    { action: "send-keys", keys: ["up"] },
    "Session process cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.",
  ],
  ["literal constructor key", { action: "send-keys", keys: ["constructor"] }, null],
] as const)("Code Mode preserves %s handling", async (_name, args, error) => {
  const session = createSession();
  session.cursorKeyMode = "unknown";
  const write = vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, callback) =>
    callback?.(),
  );
  session.stdin = { write, end: vi.fn() };
  expect(await runProcessInCodeMode({ sessionId: session.id, ...args })).toMatchObject({
    status: "completed",
    value: error ? { status: "failed", error } : { status: "running", sessionId: session.id },
  });
  if (error) {
    expect(write).not.toHaveBeenCalled();
  } else {
    expect(write).toHaveBeenCalledExactlyOnceWith(Buffer.from("constructor"), expect.any(Function));
  }
});

test("a retained old snapshot cannot consume a successor poll delivery", async () => {
  const h = pollFixture("old-output\n");
  h.guard();
  const result = await h.poll("old-result");
  const retained = snapshotToolSearchTargetTranscriptResult(result);
  h.appendTurn("old-result");
  h.persist("old-result", result);
  appendOutput(h.session, "stdout", "successor-output\n");
  expect(resultText(await h.poll("successor-dropped"))).toContain("successor-output");
  h.appendTurn("retained-old-result");
  h.persist("retained-old-result", retained);
  expect(resultText(await h.poll("successor-retry"))).toContain("successor-output");
});

test("does not duplicate retry output across parallel polls from one assistant turn", async () => {
  const h = pollFixture("one-copy\n");
  await h.poll("parallel-dropped");
  const turn = h.turn("parallel-first");
  expect(resultText(await h.poll("parallel-first", undefined, turn))).toContain("one-copy");
  expect(resultText(await h.poll("parallel-second", undefined, turn))).not.toContain("one-copy");
});

test("replays blocked poll output immediately when the retry has a timeout", async () => {
  const h = pollFixture("blocked-output\n");
  h.guard({
    beforeMessageWriteHook: ({ message }) =>
      message.role === "toolResult" && message.toolCallId === "blocked-result"
        ? { block: true }
        : undefined,
  });
  const dropped = await h.poll("blocked-result");
  h.appendTurn("blocked-result");
  expect(h.persist("blocked-result", dropped)).toBeUndefined();
  vi.useFakeTimers();
  let settled = false;
  const retry = h.poll("blocked-retry", 30_000).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  expect(resultText(await retry)).toContain("blocked-output");
});

test("composes lazy process actions through generated declarations and JavaScript", async () => {
  createSession("first\nsecond", "typed-process");
  const run = processCodeMode(true);
  const composition = `
    async function consume() {
      const listed = await process({ action: "list" });
      if (listed.status === "failed") throw new Error(listed.error);
      const running = listed.sessions.filter(session => session.status === "running");
      return await Promise.all(running.map(async session => {
        const log = await process({ action: "log", sessionId: session.sessionId });
        if ("error" in log) throw new Error(log.error);
        return { id: session.sessionId, lines: log.totalLines, output: log.output.toUpperCase() };
      }));
    }
  `;
  const declaration = await run('return await API.read("tools/process.d.ts");');
  expect(declaration).toMatchObject({ status: "completed" });
  const file = declaration.value as { content: string };
  expect(typeCheckSources({ "/process-consumer.ts": file.content + composition })).toEqual([]);
  const result = await run(`${composition}\nreturn await consume();`);
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    value: [{ id: "typed-process", lines: 2, output: "FIRST\nSECOND" }],
  });
});

test("keeps a poll wait live when the wall clock steps forward", async () => {
  // The wait budget measures elapsed time; a wall-clock step is not elapsed work.
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const h = pollFixture();
  const pending = h.poll("wall-clock-step", 5_000);
  vi.setSystemTime(Date.now() + 60_000);
  const append = setTimeout(() => appendOutput(h.session, "stdout", "late output\n"), 1_000);
  try {
    await vi.advanceTimersByTimeAsync(1_500);
    expect(resultText(await pending)).toContain("late output");
  } finally {
    clearTimeout(append);
    await pending;
  }
});
