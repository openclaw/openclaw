import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  embeddedAgentLog,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  THREAD_ID,
  TURN_ID,
  flushDiagnosticEvents,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  findAgentEvent,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector replay safety and progress projection", () => {
  it.each(["blocked"] as const)(
    "keeps dynamic card %s outcomes in the correct progress stream",
    async (terminalType) => {
      const onToolResult = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        verboseLevel: "full",
        onToolResult,
      });
      const text = "Card write unavailable";
      const item = {
        type: "dynamicToolCall",
        id: "card-outcome",
        tool: "progress_card",
        arguments: { markdown: '<progress aria-label="private" value="1" max="2"></progress>' },
        status: "inProgress",
      };
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      expect(onToolResult).not.toHaveBeenCalled();
      projector.recordDynamicToolCall({
        callId: item.id,
        tool: item.tool,
        arguments: item.arguments,
      });
      expect(onToolResult).not.toHaveBeenCalled();

      const result = {
        callId: item.id,
        tool: item.tool,
        success: false,
        terminalType,
        contentItems: [{ type: "inputText" as const, text }],
      };
      projector.recordDynamicToolResult(result);
      projector.recordDynamicToolResult(result);
      const completedItem = {
        ...item,
        status: "failed",
        success: false,
        contentItems: result.contentItems,
      };
      await projector.handleNotification(forCurrentTurn("item/completed", { item: completedItem }));
      await projector.handleNotification(turnCompleted([completedItem]));

      expect(onToolResult).toHaveBeenCalledTimes(2);
      expect(onToolResult).toHaveBeenCalledWith({
        text: expect.stringContaining(text),
        isError: true,
      });
      expect(JSON.stringify(onToolResult.mock.calls)).not.toContain("private");
    },
  );

  it("clears a prior terminal presentation after an unprojected native tool completes", async () => {
    const onToolOutcome = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onToolOutcome,
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageView",
          id: "image-view-clear-presentation",
          path: "/workspace/reference.png",
        },
        {
          type: "dynamicToolCall",
          id: "stale-dynamic-tool",
          turnId: "turn-old",
          tool: "web_fetch",
          arguments: {},
          status: "completed",
        },
      ]),
    );

    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalPresentation: undefined }),
    );
  });

  it("keeps a later dynamic presentation over an earlier snapshot-only native tool", async () => {
    let terminalPresentation: string | undefined = "later dynamic result";
    let latestOrdinal = 1;
    let nextOrdinal = 0;
    const projector = await createProjector({
      ...(await createParams()),
      allocateToolOutcomeOrdinal: () => nextOrdinal++,
      onToolOutcome: (observation) => {
        const ordinal = observation.toolCallOrdinal ?? latestOrdinal + 1;
        if (ordinal >= latestOrdinal) {
          latestOrdinal = ordinal;
          terminalPresentation = observation.terminalPresentation;
        }
      },
    });
    const nativeItem = {
      type: "imageView",
      id: "image-view-before-dynamic",
      path: "/workspace/reference.png",
    };

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: nativeItem,
      }),
    );

    await projector.handleNotification(
      turnCompleted([
        nativeItem,
        {
          type: "dynamicToolCall",
          id: "dynamic-after-image-view",
          turnId: TURN_ID,
          tool: "web_fetch",
          arguments: {},
          status: "completed",
        },
        {
          type: "imageView",
          id: "stale-image-view",
          turnId: "turn-old",
          path: "/workspace/stale.png",
        },
      ]),
    );

    expect(terminalPresentation).toBe("later dynamic result");
  });

  it("keeps executed dynamic tools side-effecting when their result is rewritten as blocked", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-bash-blocked",
      tool: "bash",
      arguments: { command: "touch blocked.txt" },
    });
    projector.recordDynamicToolResult({
      callId: "call-bash-blocked",
      tool: "bash",
      success: false,
      terminalType: "blocked",
      sideEffectEvidence: true,
      contentItems: [{ type: "inputText", text: "blocked" }],
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("records command sensitivity on namespaced MCP item events", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          id: "mcp-command-1",
          type: "mcpToolCall",
          server: "server",
          tool: "exec",
          status: "completed",
          arguments: { command: "echo private-sentinel" },
          result: { content: [{ type: "text", text: "done" }] },
        },
      }),
    );

    expect(
      findAgentEvent(onAgentEvent, {
        stream: "item",
        phase: "end",
        itemId: "mcp-command-1",
      }).data,
    ).toMatchObject({
      name: "server.exec",
      commandBearing: true,
      meta: expect.stringContaining("private-sentinel"),
    });
    expect(
      findAgentEvent(onAgentEvent, {
        stream: "tool",
        phase: "result",
        itemId: "mcp-command-1",
        name: "server.exec",
      }).data,
    ).toMatchObject({ commandBearing: true, isError: false });
    expect(projector.buildResult(buildEmptyToolTelemetry()).replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("keeps diagnostics for exact message-like native tool items while suppressing progress", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onAgentEvent,
      onToolResult,
    });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    const item = {
      type: "mcpToolCall",
      id: "mcp-message-1",
      server: null,
      tool: "message",
      arguments: { text: "hello" },
      error: null,
    };
    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { ...item, status: "inProgress", result: null, durationMs: null },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { ...item, status: "completed", result: { ok: true }, durationMs: 7 },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const toolEvents = onAgentEvent.mock.calls.filter(([event]) => {
      const record = requireRecord(event, "agent event");
      return record.stream === "tool";
    });
    expect(toolEvents).toHaveLength(0);
    expect(onToolResult).not.toHaveBeenCalled();

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        {
          type:
            | "tool.execution.started"
            | "tool.execution.completed"
            | "tool.execution.error"
            | "tool.execution.blocked";
        }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        durationMs: "durationMs" in event ? event.durationMs : undefined,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "message",
        toolCallId: "mcp-message-1",
        durationMs: undefined,
      },
      {
        type: "tool.execution.completed",
        toolName: "message",
        toolCallId: "mcp-message-1",
        durationMs: 7,
      },
    ]);
  });

  it("warns once and preserves projection for an unknown Codex-native item status", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const notification = forCurrentTurn("item/completed", {
      item: createNativeCommandItem({
        id: "cmd-future-status",
        status: "pausedByProtocol",
        exitCode: null,
        durationMs: null,
      }),
    });

    await projector.handleNotification(notification);
    await projector.handleNotification(notification);

    expect(
      findAgentEvent(onAgentEvent, {
        stream: "item",
        phase: "end",
        itemId: "cmd-future-status",
      }).data,
    ).toMatchObject({ phase: "end", summary: "Outcome unknown" });
    expect(
      findAgentEvent(onAgentEvent, {
        stream: "item",
        phase: "end",
        itemId: "cmd-future-status",
      }).data.status,
    ).toBeUndefined();
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-future-status",
      name: "bash",
    }).data;
    expect(toolResult).toMatchObject({ status: "completed", isError: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server item reported unknown status; continuing projection",
      {
        itemId: "cmd-future-status",
        itemType: "commandExecution",
        status: "pausedByProtocol",
      },
    );
  });

  it("warns once per raw unknown event kind and continues projecting known events", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = await createParams();
    const onPartialReply = vi.fn();
    const projector = await createProjector({ ...params, onPartialReply });
    await projector.handleNotification(forCurrentTurn("thread/compacted", {}));
    expect(warn).not.toHaveBeenCalled();
    const rawEventKind = "item/futureStatus/updated\nforged";
    const collidingSanitizedEventKind = "item/futureStatus/updated\\nforged";
    const notification = forCurrentTurn(rawEventKind, {
      itemId: "future-1",
    });

    await projector.handleNotification(notification);
    await projector.handleNotification(notification);
    await projector.handleNotification(
      forCurrentTurn(collidingSanitizedEventKind, { itemId: "future-2" }),
    );
    const item = {
      type: "agentMessage",
      id: "msg-after-unknown",
      phase: "final_answer",
      text: "still projects",
    };
    await projector.handleNotification(
      forCurrentTurn("item/started", { item: { ...item, text: "" } }),
    );
    await projector.handleNotification(agentMessageDelta(item.text, item.id));
    await projector.handleNotification(forCurrentTurn("item/completed", { item }));
    await projector.handleNotification(turnCompleted([item]));

    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "still projects",
    ]);
    expect(onPartialReply).toHaveBeenCalledWith({
      text: "still projects",
      delta: "still projects",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server projector received unknown event kind; continuing: item/futureStatus/updated\\nforged",
      {
        eventKind: "item/futureStatus/updated\\nforged",
        activeThreadId: THREAD_ID,
        activeTurnId: TURN_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        matchesActiveThread: true,
        matchesActiveTurn: true,
      },
    );
  });
});

describe("subagent-progress", () => {
  it("projects native subagent activity into tool progress", async () => {
    const toolProgress = true;
    const update = vi.fn((_text: string) => true);
    const progress = createChannelProgressDraftCompositor({
      active: true,
      mode: "progress",
      entry: { streaming: { mode: "progress", progress: { toolProgress } } },
      seed: "subagent-progress",
      update,
    });
    const events: Array<Record<string, unknown>> = [];
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent: async (event) => {
        if (event.stream === "item") {
          events.push(event.data);
          await progress.pushItemEvent(event.data);
        }
      },
    });
    try {
      for (const kind of ["started", "interrupted", "completed", "interacted"]) {
        const item = {
          id: `activity-${kind}`,
          type: "subAgentActivity",
          kind,
          agentThreadId: "child-thread",
          agentPath: "/root/research",
        };
        await projector.handleNotification(forCurrentTurn("item/started", { item }));
        await projector.handleNotification(forCurrentTurn("item/completed", { item }));
        await progress.start();
        const latest = events.at(-1);
        expect(latest).toMatchObject({
          status: kind === "interrupted" ? "failed" : kind === "started" ? "running" : "completed",
        });
        expect(progress.getSnapshot().lines).toHaveLength(kind === "interacted" ? 2 : 1);
        expect(update.mock.lastCall?.[0]).toContain("Working");
        expect(update.mock.lastCall?.[0]).toContain("research");
        expect(update.mock.lastCall?.[0]).toContain(kind === "interacted" ? "message sent" : kind);
      }
      expect(new Set(events.slice(0, -1).map((event) => event.itemId)).size).toBe(1);
      expect(events.at(-1)?.itemId).not.toBe(events[0]?.itemId);
    } finally {
      progress.cancel();
    }
  });

  it("projects native collaboration calls without exposing their prompts", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const item = {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "thread-1",
      receiverThreadIds: ["child-thread"],
      prompt: "Private delegation instructions",
      agentsStates: {},
    };
    await projector.handleNotification(forCurrentTurn("item/started", { item }));
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "item",
        data: expect.objectContaining({ status: "running", name: "subagents" }),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", { item: { ...item, status: "failed" } }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "item",
        data: expect.objectContaining({ status: "failed", name: "subagents" }),
      }),
    );
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(item.prompt);
    onAgentEvent.mockClear();
    const wait = { ...item, id: "wait-1", tool: "wait" };
    await projector.handleNotification(forCurrentTurn("item/started", { item: wait }));
    await projector.handleNotification(
      forCurrentTurn("item/completed", { item: { ...wait, status: "completed" } }),
    );
    expect(
      onAgentEvent.mock.calls
        .filter(([event]) => event.stream === "item")
        .map(([event]) => event.data.hideFromChannelProgress),
    ).toEqual([true, true]);
    onAgentEvent.mockClear();
    await projector.handleNotification(
      forCurrentTurn("item/completed", { item: { ...wait, id: "failed-wait", status: "failed" } }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "item",
        data: expect.objectContaining({ status: "failed", name: "subagents" }),
      }),
    );
    expect(
      onAgentEvent.mock.calls
        .filter(([event]) => event.stream === "item")
        .every(([event]) => !event.data.hideFromChannelProgress),
    ).toBe(true);
  });
});

const buffering = {
  model: "gpt-5.6-sol",
  useCases: ["cyber"],
  reasons: ["user_risk"],
  showBufferingUi: true,
  fasterModel: "gpt-5.4-codex-mini",
};

async function createNoticeProjector(provider = "openai") {
  const onAgentEvent = vi.fn();
  const projector = await createProjector({ ...(await createParams()), provider, onAgentEvent });
  return {
    projector,
    onAgentEvent,
    buffer: (params = buffering) =>
      projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", params)),
    notices: () =>
      onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "notice"),
  };
}

describe("CodexAppServerEventProjector cyber notices", () => {
  it("clears hidden buffering without claiming a model switch", async () => {
    const { buffer, notices, onAgentEvent } = await createNoticeProjector();
    await buffer();
    await buffer({ ...buffering, useCases: [], showBufferingUi: false });
    expect(notices()).toEqual([
      {
        stream: "notice",
        data: {
          phase: "provider_policy",
          category: "cyber",
          state: "buffering",
          provider: "openai",
          model: buffering.model,
          fallbackModel: buffering.fasterModel,
        },
      },
      {
        stream: "notice",
        data: { phase: "provider_policy", category: "cyber", state: "cleared", provider: "openai" },
      },
    ]);
    expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "fallback")).toBe(false);
  });
  it("shows the first buffering notice after commentary and retires it when the answer starts", async () => {
    const { projector, buffer, notices } = await createNoticeProjector();
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "commentary",
          phase: "commentary",
          text: "I will review the code.",
        },
      }),
    );
    await buffer();
    await projector.handleNotification(agentMessageDelta("Ready"));
    await buffer();
    expect(notices().map((event) => event.data.state)).toEqual(["buffering", "cleared"]);
  });
  it("does not label another provider as OpenAI", async () => {
    const { buffer, onAgentEvent } = await createNoticeProjector("other");
    await buffer();
    expect(onAgentEvent).not.toHaveBeenCalled();
  });
});
