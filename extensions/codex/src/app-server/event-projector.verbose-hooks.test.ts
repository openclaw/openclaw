import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as compactionActivity from "./context-compaction-activity.js";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import * as fixture from "./event-projector.compact.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  SessionManager,
  expect,
  it,
  vi,
  THREAD_ID,
  TURN_ID,
  createParams,
  createProjector,
  createProjectorWithHooks,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  findAgentEvent,
} from "./event-projector.test-harness.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import * as sessionHistory from "./session-history.js";
registerCodexEventProjectorTestLifecycle();
const hookRun = {
  id: "hook-1",
  eventName: "preToolUse",
  scope: "turn",
  status: "running",
};

describe("CodexAppServerEventProjector verbose output and hook projection", () => {
  async function verboseProjector(verboseLevel: "on" | "full", raw = false) {
    const onToolResult = vi.fn();
    const { projector } = await fixture.observe({
      verboseLevel,
      ...(raw ? { toolProgressDetail: "raw" as const } : {}),
      onToolResult,
    });
    return { projector, onToolResult };
  }
  it("preserves source text in verbose command summaries", async () => {
    const { projector, onToolResult } = await verboseProjector("full", true);
    await fixture.start(
      projector,
      createNativeCommandItem({
        id: "cmd-1",
        command: "OPENAI_API_KEY=sk-1234567890abcdefZZZZ pnpm test",
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      }),
    );
    expect(onToolResult.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("OPENAI_API_KEY=sk-1234567890abcdefZZZZ pnpm test"),
    });
  });

  it("hides command arguments from ordinary verbose dynamic tool summaries", async () => {
    const { projector, onToolResult } = await verboseProjector("on");
    projector.recordDynamicToolCall({
      callId: "tool-command-1",
      tool: "server.exec",
      arguments: { command: "cat /private/operator-file" },
    });
    expect(onToolResult).toHaveBeenCalledWith({ text: "Server.exec" });
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain("private/operator-file");
  });

  it("emits a summary and completed dynamic tool output when verbose is full", async () => {
    const { projector, onToolResult } = await verboseProjector("full");
    projector.recordDynamicToolCall({
      callId: "tool-1",
      tool: "read",
      arguments: { path: "README.md" },
    });
    projector.recordDynamicToolResult({
      callId: "tool-1",
      tool: "read",
      contentItems: [{ type: "inputText", text: "file contents" }],
      success: true,
    });
    expect(onToolResult.mock.calls).toEqual([
      [{ text: "Read: `from README.md`" }],
      [{ text: "Read\n```txt\nfile contents\n```" }],
    ]);
  });

  it("continues projecting turn completion when an event consumer throws", async () => {
    const onAgentEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const { projector } = await fixture.observe({ onAgentEvent });
    await fixture.finish(projector, [
      { type: "plan", id: "plan-1", text: "step one\nstep two" },
      fixture.message("msg-1", "final answer"),
    ]);
    const result = fixture.result(projector);
    expect(findAgentEvent(onAgentEvent, { stream: "plan" }).data.steps).toEqual([
      { step: "step one", status: "pending" },
      { step: "step two", status: "pending" },
    ]);
    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Codex plan:");
  });

  it("projects repeated Codex compaction completion once", async () => {
    const agentHookContext = {
      runId: "run-1",
      sessionId: "session-1",
      accountId: "account-a",
      channel: "telegram",
      channelId: "chat-a",
      chatId: "chat-a",
      senderId: "sender-a",
      channelContext: { sender: { id: "sender-a" }, chat: { id: "chat-a" } },
    };
    const onContextCompacted = vi.fn();
    const { projector, beforeCompaction, afterCompaction } = await createProjectorWithHooks({
      agentHookContext,
      onContextCompacted,
    });
    const openSpy = vi.spyOn(SessionManager, "open");
    await fixture.start(projector, { type: "contextCompaction", id: "compact-1" });
    await fixture.complete(projector, { type: "contextCompaction", id: "compact-1" });
    await fixture.complete(projector, { type: "contextCompaction", id: "compact-1" });
    expect(openSpy).not.toHaveBeenCalled();
    expect(fixture.result(projector).compactionCount).toBe(1);
    expect(onContextCompacted).toHaveBeenCalledOnce();
    for (const [hook, detail] of [
      [beforeCompaction, { messages: [expect.objectContaining({ role: "assistant" })] }],
      [afterCompaction, { compactedCount: -1 }],
    ] as const) {
      expect(hook).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          messageCount: 1,
          sessionFile: expect.stringContaining("session.jsonl"),
          ...detail,
        }),
        expect.objectContaining(agentHookContext),
      );
    }
  });

  it.each([
    ["item/started", "history", "closed"],
    ["item/started", "hook", "aborted"],
    ["item/completed", "history", "run aborted"],
    ["item/completed", "hook", "aborted"],
  ] as const)("%s stops during %s after %s", async (method, pendingStage, ending) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const runAbort = new AbortController();
    const read = vi
      .spyOn(sessionHistory, "readCodexMirroredSessionHistoryMessages")
      .mockImplementation(async () => {
        if (pendingStage === "history") {
          entered.resolve();
          await release.promise;
        }
        return [];
      });
    const hook = vi.fn(async () => {
      if (pendingStage === "hook") {
        entered.resolve();
        await release.promise;
      }
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: method === "item/started" ? "before_compaction" : "after_compaction",
          handler: hook,
        },
      ]),
    );
    const onAgentEvent = vi.fn();
    const persistActivity = vi.spyOn(compactionActivity, "persistCodexContextCompactionActivity");
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent },
      { runAbortSignal: runAbort.signal },
    );
    const notification = fixture.notify(projector, method, {
      item: { type: "contextCompaction", id: "compact-late" },
    });
    await entered.promise;
    if (ending === "closed") {
      await projector.closeProjection();
    } else if (ending === "aborted") {
      projector.markAborted();
    } else {
      runAbort.abort(new Error("run ended during compaction projection"));
    }
    release.resolve();
    await notification;
    expect(hook).toHaveBeenCalledTimes(pendingStage === "hook" ? 1 : 0);
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(persistActivity).not.toHaveBeenCalled();
    expect(read.mock.calls[0]?.[2]).toBe(runAbort.signal);
  });

  it.each([false, true])(
    "projects hook notifications (thread scoped: %s)",
    async (threadScoped) => {
      const { projector, events } = await fixture.observe();
      const run = threadScoped
        ? { ...hookRun, id: "hook-thread-1", eventName: "sessionStart", scope: "thread" }
        : hookRun;
      await projector.handleNotification(
        prepareCodexServerNotification({
          method: "hook/started",
          params: { threadId: THREAD_ID, turnId: threadScoped ? null : TURN_ID, run },
        }),
      );
      expect(events("codex_app_server.hook", "started")[0]).toMatchObject({
        threadId: THREAD_ID,
        turnId: threadScoped ? null : TURN_ID,
        hookRunId: run.id,
        eventName: run.eventName,
        ...(threadScoped ? { scope: "thread" } : { status: "running" }),
      });
      if (!threadScoped) {
        const completion = {
          status: "blocked",
          statusMessage: "blocked by hook",
          durationMs: 42,
          entries: [{ kind: "stderr", text: "blocked" }],
        };
        await fixture.notify(projector, "hook/completed", { run: { ...run, ...completion } });
        const completed = events("codex_app_server.hook", "completed")[0];
        expect(completed).toMatchObject({ hookRunId: run.id, ...completion });
        expect(completed.entries).toEqual(completion.entries);
      }
    },
  );
});
