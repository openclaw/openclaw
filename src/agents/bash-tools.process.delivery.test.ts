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
import { boundCodeModeError } from "./code-mode-json.js";
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
import type { AgentMessage, AgentToolResult } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
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

function resultText(result: AgentToolResult<unknown>) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function toolResultMessage(
  toolCallId: string,
  result: AgentToolResult<unknown>,
): Extract<AgentMessage, { role: "toolResult" }> {
  return copyInternalToolResultState(result, {
    role: "toolResult",
    toolCallId,
    toolName: "process",
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  });
}

function pollFixture(output = "") {
  const session = createSession(output);
  const tool = createProcessTool();
  const manager = SessionManager.inMemory();
  const guard = (options?: Parameters<typeof installSessionToolResultGuard>[1]) =>
    installSessionToolResultGuard(manager, options);
  const turn = (id: string) => toolTurn(id, "process", { action: "poll", sessionId: session.id });
  const poll = (id: string, timeout?: number, context = turn(id)) =>
    runWithAgentToolExecutionContext(context, () =>
      tool.execute(id, {
        action: "poll",
        sessionId: session.id,
        ...(timeout === undefined ? {} : { timeout }),
      }),
    );
  const persist = (id: string, result: AgentToolResult<unknown>) =>
    manager.appendMessage(toolResultMessage(id, result));
  return { session, manager, guard, turn, poll, persist };
}

async function runProcessInCodeMode(args: Record<string, unknown>) {
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createProcessTool()] });
  return await runUntilCompleted({
    execTool: expectDefined(h.tools[0], "Code Mode exec"),
    waitTool: expectDefined(h.tools[1], "Code Mode wait"),
    code: `return await process(${JSON.stringify(args)});`,
  });
}

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
  const append = h.manager.appendMessageWithTranscriptAnchor.bind(h.manager);
  let rejectAppend = true;
  vi.spyOn(h.manager, "appendMessageWithTranscriptAnchor").mockImplementation(
    (message, options) => {
      if (message.role === "toolResult" && rejectAppend) {
        throw new Error("result persistence failed");
      }
      return append(message, options);
    },
  );
  h.guard();
  h.manager.appendMessage(h.turn("persist-notify").assistantMessage);
  expect(() => h.persist("persist-notify", result)).toThrow("result persistence failed");
  recordCompletion();
  expect(peekSystemEventEntries(sessionKey)).toHaveLength(2);
  rejectAppend = false;
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
  h.manager.appendMessage(h.turn("dropped").assistantMessage);
  guard.flushPendingToolResults();
  const retry = snapshotToolSearchTargetTranscriptResult(await h.poll("retry"));
  expect(resultText(retry)).toContain("running-output");
  h.manager.appendMessage(h.turn("retry").assistantMessage);
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
      const first = await poll("nested-first");
      expect(first, boundCodeModeError(JSON.stringify(first), 1_024)).toMatchObject({
        status: "completed",
      });
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
      expect((await h.readNestedActivities()).at(-1)?.details.result.content).not.toContainEqual(
        output,
      );
      expect(
        h.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "custom"),
      ).toHaveLength(2);
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
      output: `${lines.slice(5).join("\n")}\n\n[showing last 200 of 205 lines; pass offset/limit to page]`,
    },
  });
  expect(
    await runProcessInCodeMode({ action: "log", sessionId: session.id, offset: 1, limit: 1 }),
  ).toMatchObject({
    status: "completed",
    value: { status: "completed", output: "line-1", totalLines: 205 },
  });
});

test.each([
  { action: "paste", text: "", bracketed: false, error: "No paste text provided." },
  {
    action: "send-keys",
    keys: ["up"],
    error:
      "Session process cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.",
  },
])("Code Mode preserves actionable $action failures", async ({ error, ...args }) => {
  const session = createSession();
  session.cursorKeyMode = "unknown";
  const write = vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, callback) =>
    callback?.(),
  );
  session.stdin = { write, end: vi.fn() };
  expect(await runProcessInCodeMode({ sessionId: session.id, ...args })).toMatchObject({
    status: "completed",
    value: { status: "failed", error },
  });
  expect(write).not.toHaveBeenCalled();
});

test("send-keys writes literal constructor before the cursor key mode is known", async () => {
  const key = "constructor";
  const session = createSession();
  session.cursorKeyMode = "unknown";
  const write = vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, callback) =>
    callback?.(),
  );
  session.stdin = { write, end: vi.fn() };

  const result = await createProcessTool().execute("literal-key", {
    action: "send-keys",
    sessionId: session.id,
    keys: [key],
  });

  expect(result.details).toMatchObject({ status: "running", sessionId: session.id });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(Buffer.from(key), expect.any(Function));
});

test("a retained old snapshot cannot consume a successor poll delivery", async () => {
  const h = pollFixture("old-output\n");
  h.guard();
  const result = await h.poll("old-result");
  const retained = snapshotToolSearchTargetTranscriptResult(result);
  h.manager.appendMessage(h.turn("old-result").assistantMessage);
  h.persist("old-result", result);
  appendOutput(h.session, "stdout", "successor-output\n");
  expect(resultText(await h.poll("successor-dropped"))).toContain("successor-output");
  h.manager.appendMessage(h.turn("retained-old-result").assistantMessage);
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
  h.manager.appendMessage(h.turn("blocked-result").assistantMessage);
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
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createLazyProcessTool()] });
  const run = (code: string) =>
    runUntilCompleted({ execTool: h.tools[0]!, waitTool: h.tools[1]!, code });
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
