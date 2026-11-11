import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import { createConfiguredProjection } from "./event-projector-projection.test-support.js";
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
  findAgentEvent,
  forCurrentTurn,
  type DiagnosticEventPayload,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function imageView(id: string, overrides: Record<string, unknown> = {}) {
  return { type: "imageView", id, path: "/workspace/reference.png", ...overrides };
}
function dynamicItem(id: string, turnId: string) {
  return {
    type: "dynamicToolCall",
    id,
    turnId,
    tool: "web_fetch",
    arguments: {},
    status: "completed",
  };
}
function eventData(mock: unknown, itemId: string) {
  return (stream: string, phase: string, name?: string) =>
    findAgentEvent(mock, { stream, phase, itemId, ...(name ? { name } : {}) }).data;
}
function expectSubagentStatus(mock: ReturnType<typeof vi.fn>, status: string) {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining({
      stream: "item",
      data: expect.objectContaining({ status, name: "subagents" }),
    }),
  );
}
function streamData(mock: ReturnType<typeof vi.fn>, stream: string) {
  return mock.mock.calls.filter(([event]) => event.stream === stream).map(([event]) => event.data);
}

describe("CodexAppServerEventProjector replay safety and progress projection", () => {
  it("keeps executed blocked card outcomes side-effecting and in the correct progress stream", async () => {
    const onToolResult = vi.fn();
    const { projector, events } = await createConfiguredProjection({
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
    await events.started(item);
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
      terminalType: "blocked" as const,
      sideEffectEvidence: true,
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
    await events.completed(completedItem);
    await events.complete([completedItem]);

    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenCalledWith({
      text: expect.stringContaining(text),
      isError: true,
    });
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain("private");
    expect(events.result().replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it.each([false, true])(
    "preserves native outcome precedence with a later dynamic presentation=%s",
    async (preserveDynamic) => {
      let terminalPresentation: string | undefined = "later dynamic result";
      let latestOrdinal = 1;
      let nextOrdinal = 0;
      const onToolOutcome = vi.fn<NonNullable<EmbeddedRunAttemptParams["onToolOutcome"]>>(
        (observation) => {
          if (!preserveDynamic) {
            return;
          }
          const ordinal = observation.toolCallOrdinal ?? latestOrdinal + 1;
          if (ordinal >= latestOrdinal) {
            latestOrdinal = ordinal;
            terminalPresentation = observation.terminalPresentation;
          }
        },
      );
      const { events } = await createConfiguredProjection({
        onToolOutcome,
        ...(preserveDynamic ? { allocateToolOutcomeOrdinal: () => nextOrdinal++ } : {}),
      });
      const nativeItem = imageView("native-view");
      if (preserveDynamic) {
        await events.completed(nativeItem);
      }
      await events.complete([
        nativeItem,
        dynamicItem("dynamic-tool", preserveDynamic ? TURN_ID : "turn-old"),
        ...(preserveDynamic
          ? [imageView("stale-view", { turnId: "turn-old", path: "/workspace/stale.png" })]
          : []),
      ]);
      if (preserveDynamic) {
        expect(terminalPresentation).toBe("later dynamic result");
      } else {
        expect(onToolOutcome).toHaveBeenLastCalledWith(
          expect.objectContaining({ terminalPresentation: undefined }),
        );
      }
    },
  );

  it("records command sensitivity on namespaced MCP item events", async () => {
    const onAgentEvent = vi.fn();
    const { events } = await createConfiguredProjection({ onAgentEvent });

    await events.completed({
      id: "mcp-command-1",
      type: "mcpToolCall",
      server: "server",
      tool: "exec",
      status: "completed",
      arguments: { command: "echo private-sentinel" },
      result: { content: [{ type: "text", text: "done" }] },
    });

    const event = eventData(onAgentEvent, "mcp-command-1");
    expect(event("item", "end")).toMatchObject({
      name: "server.exec",
      commandBearing: true,
      meta: expect.stringContaining("private-sentinel"),
    });
    expect(event("tool", "result", "server.exec")).toMatchObject({
      commandBearing: true,
      isError: false,
    });
    expect(events.result().replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("keeps diagnostics for exact message-like native tool items while suppressing progress", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const { events } = await createConfiguredProjection({
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
      await events.started({ ...item, status: "inProgress", result: null, durationMs: null });
      await events.completed({ ...item, status: "completed", result: { ok: true }, durationMs: 7 });
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(streamData(onAgentEvent, "tool")).toHaveLength(0);
    expect(onToolResult).not.toHaveBeenCalled();

    const identity = { toolName: "message", toolCallId: "mcp-message-1" };
    const audit = diagnosticEvents.filter((event) => event.type.startsWith("tool.execution."));
    expect(audit).toMatchObject([
      { ...identity, type: "tool.execution.started" },
      { ...identity, type: "tool.execution.completed", durationMs: 7 },
    ]);
    const start = audit[0];
    expect(start && "durationMs" in start ? start.durationMs : undefined).toBeUndefined();
  });

  it("warns once and preserves projection for an unknown Codex-native item status", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const onAgentEvent = vi.fn();
    const { projector } = await createConfiguredProjection({ onAgentEvent });
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

    const event = eventData(onAgentEvent, "cmd-future-status");
    const itemEvent = event("item", "end");
    expect(itemEvent).toMatchObject({ phase: "end", summary: "Outcome unknown" });
    expect(itemEvent.status).toBeUndefined();
    expect(event("tool", "result", "bash")).toMatchObject({ status: "completed", isError: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once per raw unknown event kind and continues projecting known events", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const onPartialReply = vi.fn();
    const { projector, events } = await createConfiguredProjection({ onPartialReply });
    await events.notify("thread/compacted", {});
    expect(warn).not.toHaveBeenCalled();
    const rawEventKind = "item/futureStatus/updated\nforged";
    const collidingSanitizedEventKind = "item/futureStatus/updated\\nforged";
    const notification = forCurrentTurn(rawEventKind, { itemId: "future-1" });

    await projector.handleNotification(notification);
    await projector.handleNotification(notification);
    await events.notify(collidingSanitizedEventKind, { itemId: "future-2" });
    const item = {
      type: "agentMessage",
      id: "msg-after-unknown",
      phase: "final_answer",
      text: "still projects",
    };
    await events.started({ ...item, text: "" });
    await events.delta(item.text, item.id);
    await events.completed(item);
    await events.complete([item]);

    expect(events.result().assistantTexts).toEqual(["still projects"]);
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
    const update = vi.fn((_text: string) => true);
    const progress = createChannelProgressDraftCompositor({
      active: true,
      mode: "progress",
      entry: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      seed: "subagent-progress",
      update,
    });
    const itemEvents: Array<Record<string, unknown>> = [];
    const { events } = await createConfiguredProjection({
      onAgentEvent: async (event) => {
        if (event.stream === "item") {
          itemEvents.push(event.data);
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
        await events.started(item);
        await events.completed(item);
        await progress.start();
        const latest = itemEvents.at(-1);
        expect(latest).toMatchObject({
          status: kind === "interrupted" ? "failed" : kind === "started" ? "running" : "completed",
        });
        expect(progress.getSnapshot().lines).toHaveLength(kind === "interacted" ? 2 : 1);
        expect(update.mock.lastCall?.[0]).toContain("Working");
        expect(update.mock.lastCall?.[0]).toContain("research");
        expect(update.mock.lastCall?.[0]).toContain(kind === "interacted" ? "message sent" : kind);
      }
      expect(new Set(itemEvents.slice(0, -1).map((event) => event.itemId)).size).toBe(1);
      expect(itemEvents.at(-1)?.itemId).not.toBe(itemEvents[0]?.itemId);
    } finally {
      progress.cancel();
    }
  });

  it("projects native collaboration calls without exposing their prompts", async () => {
    const onAgentEvent = vi.fn();
    const { events } = await createConfiguredProjection({ onAgentEvent });
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
    await events.started(item);
    expectSubagentStatus(onAgentEvent, "running");
    await events.completed({ ...item, status: "failed" });
    expectSubagentStatus(onAgentEvent, "failed");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(item.prompt);
    onAgentEvent.mockClear();
    const wait = { ...item, id: "wait-1", tool: "wait" };
    await events.started(wait);
    await events.completed({ ...wait, status: "completed" });
    expect(streamData(onAgentEvent, "item").map((data) => data.hideFromChannelProgress)).toEqual([
      true,
      true,
    ]);
    onAgentEvent.mockClear();
    await events.completed({ ...wait, id: "failed-wait", status: "failed" });
    expectSubagentStatus(onAgentEvent, "failed");
    expect(streamData(onAgentEvent, "item").every((data) => !data.hideFromChannelProgress)).toBe(
      true,
    );
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
  const { events } = await createConfiguredProjection({ provider, onAgentEvent });
  return {
    events,
    onAgentEvent,
    buffer: (params = buffering) => events.notify("model/safetyBuffering/updated", params),
    notices: () => streamData(onAgentEvent, "notice"),
  };
}

describe("CodexAppServerEventProjector cyber notices", () => {
  it("clears hidden buffering without claiming a model switch", async () => {
    const { buffer, notices, onAgentEvent } = await createNoticeProjector();
    await buffer();
    await buffer({ ...buffering, useCases: [], showBufferingUi: false });
    const policy = { phase: "provider_policy", category: "cyber", provider: "openai" };
    expect(notices()).toEqual([
      {
        ...policy,
        state: "buffering",
        model: buffering.model,
        fallbackModel: buffering.fasterModel,
      },
      { ...policy, state: "cleared" },
    ]);
    expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "fallback")).toBe(false);
  });
  it("shows the first buffering notice after commentary and retires it when the answer starts", async () => {
    const { events, buffer, notices } = await createNoticeProjector();
    await events.completed({
      type: "agentMessage",
      id: "commentary",
      phase: "commentary",
      text: "I will review the code.",
    });
    await buffer();
    await events.delta("Ready");
    await buffer();
    expect(notices().map((data) => data.state)).toEqual(["buffering", "cleared"]);
  });
  it("does not label another provider as OpenAI", async () => {
    const { buffer, onAgentEvent } = await createNoticeProjector("other");
    await buffer();
    expect(onAgentEvent).not.toHaveBeenCalled();
  });
});
