import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as compactionActivity from "./context-compaction-activity.js";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
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
  buildEmptyToolTelemetry,
  mockCallArg,
  findAgentEvent,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";
import * as sessionHistory from "./session-history.js";

registerCodexEventProjectorTestLifecycle();

const hookRun = {
  id: "hook-1",
  eventName: "preToolUse",
  handlerType: "command",
  executionMode: "sync",
  scope: "turn",
  source: "project",
  sourcePath: "/repo/.codex/hooks.json",
  status: "running",
  statusMessage: null,
  entries: [],
};

describe("CodexAppServerEventProjector verbose output and hook projection", () => {
  it("preserves source text in verbose command summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      toolProgressDetail: "raw",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: createNativeCommandItem({
          id: "cmd-1",
          command: "OPENAI_API_KEY=sk-1234567890abcdefZZZZ pnpm test",
          status: "inProgress",
          exitCode: null,
          durationMs: null,
        }),
      }),
    );

    const text = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
    expect(text).toContain("OPENAI_API_KEY=sk-1234567890abcdefZZZZ pnpm test");
  });

  it("hides command arguments from ordinary verbose dynamic tool summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    projector.recordDynamicToolCall({
      callId: "tool-command-1",
      tool: "server.exec",
      arguments: { command: "cat /private/operator-file" },
    });

    expect(onToolResult).toHaveBeenCalledWith({ text: "Server.exec" });
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain("private/operator-file");
  });

  it("emits a summary and completed dynamic tool output when verbose is full", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

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

    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenNthCalledWith(1, {
      text: "Read: `from README.md`",
    });
    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "Read\n```txt\nfile contents\n```",
    });
  });

  it("continues projecting turn completion when an event consumer throws", async () => {
    const onAgentEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await expect(
      projector.handleNotification(
        turnCompleted([
          { type: "plan", id: "plan-1", text: "step one\nstep two" },
          { type: "agentMessage", id: "msg-1", text: "final answer" },
        ]),
      ),
    ).resolves.toBeUndefined();

    const result = projector.buildResult(buildEmptyToolTelemetry());

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
      channelContext: {
        sender: { id: "sender-a" },
        chat: { id: "chat-a" },
      },
    };
    const onContextCompacted = vi.fn();
    const { projector, beforeCompaction, afterCompaction } = await createProjectorWithHooks({
      agentHookContext,
      onContextCompacted,
    });
    const openSpy = vi.spyOn(SessionManager, "open");

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(projector.buildResult(buildEmptyToolTelemetry()).compactionCount).toBe(1);
    expect(onContextCompacted).toHaveBeenCalledOnce();
    expect(beforeCompaction).toHaveBeenCalledOnce();
    expect(afterCompaction).toHaveBeenCalledOnce();

    expect(beforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 1,
        sessionFile: expect.stringContaining("session.jsonl"),
        messages: [expect.objectContaining({ role: "assistant" })],
      }),
      expect.objectContaining(agentHookContext),
    );
    expect(afterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 1,
        compactedCount: -1,
        sessionFile: expect.stringContaining("session.jsonl"),
      }),
      expect.objectContaining(agentHookContext),
    );
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
    const notification = projector.handleNotification(
      forCurrentTurn(method, { item: { type: "contextCompaction", id: "compact-late" } }),
    );
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

  it("projects codex hook started and completed notifications into agent events", async () => {
    const onAgentEvent = vi.fn();
    const params = await createParams();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("hook/started", {
        run: hookRun,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("hook/completed", {
        run: {
          ...hookRun,
          status: "blocked",
          statusMessage: "blocked by hook",
          durationMs: 42,
          entries: [{ kind: "stderr", text: "blocked" }],
        },
      }),
    );

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "started",
    }).data;
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.turnId).toBe(TURN_ID);
    expect(started.hookRunId).toBe("hook-1");
    expect(started.eventName).toBe("preToolUse");
    expect(started.status).toBe("running");
    const completed = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "completed",
    }).data;
    expect(completed.hookRunId).toBe("hook-1");
    expect(completed.status).toBe("blocked");
    expect(completed.statusMessage).toBe("blocked by hook");
    expect(completed.durationMs).toBe(42);
    expect(completed.entries).toEqual([{ kind: "stderr", text: "blocked" }]);
  });

  it("projects thread-scoped codex hook notifications that omit a turn id", async () => {
    const onAgentEvent = vi.fn();
    const params = await createParams();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification({
      method: "hook/started",
      params: {
        threadId: THREAD_ID,
        turnId: null,
        run: { ...hookRun, id: "hook-thread-1", eventName: "sessionStart", scope: "thread" },
      },
    });

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "started",
    }).data;
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.turnId).toBeNull();
    expect(started.hookRunId).toBe("hook-thread-1");
    expect(started.eventName).toBe("sessionStart");
    expect(started.scope).toBe("thread");
  });
});
