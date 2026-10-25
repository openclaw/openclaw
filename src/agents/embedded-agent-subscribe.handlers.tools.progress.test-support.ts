import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { onAgentEvent as registerAgentEventListener } from "../infra/agent-events.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { peekAdjustedParamsForToolCall } from "./agent-tools.before-tool-call.state.js";
import { addSession, deleteSession, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

type CapturedAgentEvent = { stream?: string; data?: Record<string, unknown> };
const streamEvents = (events: CapturedAgentEvent[], stream: string) =>
  events.filter((event) => event.stream === stream);
const allHidden = (events: CapturedAgentEvent[]) =>
  events.every((event) => event.data?.hideFromChannelProgress === true);
const completedEvents = (events: CapturedAgentEvent[]) =>
  events.filter((event) => event.data?.phase === "end" || event.data?.phase === "result");
function expectProgressVisibility(
  events: CapturedAgentEvent[],
  itemsHidden: boolean,
  toolsHidden = false,
) {
  expect(allHidden(streamEvents(events, "item"))).toBe(itemsHidden);
  const toolsMatch = streamEvents(events, "tool").every(
    ({ data }) => Boolean(data?.hideFromChannelProgress) === toolsHidden,
  );
  expect(toolsMatch).toBe(true);
}
function fullDiagnostics(ctx: ToolHandlerContext) {
  ctx.params.onToolResult = vi.fn();
  ctx.shouldEmitToolResult = () => true;
  ctx.shouldEmitToolOutput = () => true;
  return (ctx.params.onAgentToolResult = vi.fn());
}
const phases = (events: CapturedAgentEvent[], stream: string) =>
  streamEvents(events, stream).map((event) => event.data?.phase);
type ToolRef = { toolName: string; toolCallId: string };
type ToolEvent<T extends AgentEvent["type"]> = Omit<Extract<AgentEvent, { type: T }>, "type">;
type Handler<T, R = void> = (ctx: ToolHandlerContext, event: T) => R;
type ToolChannelProgressFixtures = {
  createTestContext: () => { ctx: ToolHandlerContext };
  startTool: Handler<ToolEvent<"tool_execution_start">, void | Promise<void>>;
  updateTool: Handler<ToolRef & Partial<ToolEvent<"tool_execution_update">>>;
  endTool: Handler<ToolEvent<"tool_execution_end">, ReturnType<typeof handleToolExecutionEnd>>;
};

export function registerToolChannelProgressTests({
  createTestContext,
  startTool,
  updateTool,
  endTool,
}: ToolChannelProgressFixtures) {
  function contextWithEvents() {
    const { ctx } = createTestContext();
    const events: CapturedAgentEvent[] = [];
    ctx.params.onAgentEvent = (event) => void events.push(event);
    return { ctx, events };
  }
  async function runTool(
    ctx: ToolHandlerContext,
    toolRef: ToolRef & { startName?: string },
    args: unknown,
    run: () => unknown,
    hidden?: "start" | "update" | "end",
    updates = true,
  ) {
    const event = (phase: string) => ({
      ...toolRef,
      toolName: (phase === "start" && toolRef.startName) || toolRef.toolName,
      hideFromChannelProgress: hidden === phase,
    });
    await startTool(ctx, { ...event("start"), args });
    const result = await run();
    if (updates) {
      updateTool(ctx, { ...event("update"), partialResult: result });
    }
    await endTool(ctx, { ...event("end"), result, isError: false });
    return result;
  }
  describe("process poll channel progress", () => {
    it("uses executed arguments after a poll to kill hook rewrite", async () => {
      for (const explicitHide of [false, true]) {
        const { ctx, events } = contextWithEvents();
        const toolCallId = `rewrite-${explicitHide}`;
        const toolRef = { toolName: "process", toolCallId };
        const args = { action: "poll", sessionId: "fixture" };
        const executedArgs = { ...args, action: "kill" };
        const result = {
          content: [{ type: "text" as const, text: "Fixture result" }],
          details: { status: "completed" },
        };
        const registry = createTestRegistry();
        const rewrite = vi.fn(() => ({ params: executedArgs }));
        registry.typedHooks.push({
          pluginId: "rewrite-fixture",
          hookName: "before_tool_call",
          handler: rewrite,
          source: "test",
        });
        setActivePluginRegistry(registry);
        initializeGlobalHookRunner(registry);
        const execute = vi.fn(async (_toolCallId: string, _args: unknown) => {
          updateTool(ctx, { ...toolRef, partialResult: result });
          expect(peekAdjustedParamsForToolCall(toolCallId, ctx.params.runId)).toEqual(executedArgs);
          return result;
        });
        const tool = wrapToolWithBeforeToolCallHook(
          { ...createProcessTool(), execute },
          { runId: ctx.params.runId },
        );
        try {
          await startTool(ctx, { ...toolRef, args, hideFromChannelProgress: explicitHide });
          const observedResult = await tool.execute(toolCallId, args);
          await endTool(ctx, { ...toolRef, result: observedResult, isError: false });
          expect(rewrite).toHaveBeenCalledOnce();
          expect(execute.mock.calls[0]?.[1]).toEqual(executedArgs);
          const start = events.filter((event) => event.data?.phase === "start");
          const settled = events.filter((event) => event.data?.phase !== "start");
          expect(start).toHaveLength(2);
          expect(settled).toHaveLength(4);
          expectProgressVisibility(start, true, explicitHide);
          expectProgressVisibility(settled, explicitHide, explicitHide);
          expect(peekAdjustedParamsForToolCall(toolCallId, ctx.params.runId)).toBeUndefined();
        } finally {
          const emptyRegistry = createTestRegistry();
          setActivePluginRegistry(emptyRegistry);
          initializeGlobalHookRunner(emptyRegistry);
        }
      }
    });

    it("hides successful polls without losing lifecycle or full diagnostics", async () => {
      const { ctx, events: callbacks } = contextWithEvents();
      const onAgentToolResult = fullDiagnostics(ctx);
      const emitted: CapturedAgentEvent[] = [];
      const unsubscribe = registerAgentEventListener((event) => emitted.push(event));
      const session = createProcessSessionFixture({ id: "progress-poll", backgrounded: true });
      addSession(session);
      try {
        for (const status of ["running", "completed"] as const) {
          if (status === "completed") {
            markExited(session, 0, null, "completed");
          }
          const toolCallId = `poll-${status}`;
          const toolRef = { toolName: "process", toolCallId };
          const args = { action: "poll", sessionId: session.id };
          const result = await runTool(ctx, { ...toolRef, startName: " Process " }, args, () =>
            createProcessTool().execute(toolCallId, args),
          );
          expect(result).toMatchObject({ details: { status } });
          expect(onAgentToolResult).toHaveBeenCalledWith({
            toolName: "process",
            result,
            isError: false,
          });
          for (const events of [callbacks, emitted]) {
            const lifecycle = events.filter((event) => event.data?.toolCallId === toolCallId);
            expect({ tool: phases(lifecycle, "tool"), item: phases(lifecycle, "item") }).toEqual({
              tool: ["start", "update", "result"],
              item: ["start", "update", "end"],
            });
            expectProgressVisibility(lifecycle, true);
          }
          expect(emitted).toContainEqual(
            expect.objectContaining({
              stream: "tool",
              data: expect.objectContaining({ toolCallId, phase: "result", result }),
            }),
          );
        }
        expect(ctx.emitToolSummary).toHaveBeenCalledTimes(2);
        expect(ctx.emitToolOutput).toHaveBeenCalledTimes(2);
        expect(ctx.state.itemActiveIds.size).toBe(0);
        expect(ctx.state.itemStartedCount).toBe(2);
        expect(ctx.state.itemCompletedCount).toBe(2);
        expect(ctx.state.toolMetaById.size).toBe(0);
        expect(ctx.state.toolSummaryById.size).toBe(0);
        expect(ctx.state.toolMetas).toEqual([
          expect.objectContaining({ toolCallId: "poll-running", isError: false }),
          expect.objectContaining({ toolCallId: "poll-completed", isError: false }),
        ]);
      } finally {
        unsubscribe();
        deleteSession(session.id);
      }
    });

    it.each(["missing", "nonzero", "timeout"] as const)(
      "exposes a real %s poll failure unless explicitly hidden",
      async (failure) => {
        for (const explicitHide of [undefined, "start", "update", "end"] as const) {
          const { ctx, events } = contextWithEvents();
          const session = createProcessSessionFixture({
            id: `poll-${failure}`,
            backgrounded: true,
          });
          if (failure !== "missing") {
            addSession(session);
            markExited(
              session,
              failure === "nonzero" ? 1 : 0,
              null,
              failure === "nonzero" ? "completed" : "failed",
              failure === "timeout" ? "overall-timeout" : "exit",
            );
          }
          try {
            const toolCallId = `poll-${failure}-${explicitHide}`;
            const toolRef = { toolName: "process", toolCallId };
            const args = { action: "poll", sessionId: session.id };
            await runTool(
              ctx,
              toolRef,
              args,
              () => createProcessTool().execute(toolCallId, args),
              explicitHide,
            );
            const completed = completedEvents(events);
            expect(completed).toHaveLength(2);
            expect(allHidden(completed)).toBe(explicitHide !== undefined);
            expect(events).toContainEqual(
              expect.objectContaining({
                stream: "tool",
                data: expect.objectContaining({ phase: "result", isError: failure !== "nonzero" }),
              }),
            );
            expect(completed.find((event) => event.stream === "item")?.data?.status).toBe("failed");
            if (failure === "nonzero") {
              expect(ctx.state.lastToolError).toBeUndefined();
            } else {
              expect(ctx.state.lastToolError).toMatchObject({ toolName: "process" });
            }
          } finally {
            deleteSession(session.id);
          }
        }
      },
    );
  });

  describe("sessions_yield channel progress privacy", () => {
    it("keeps continuation context out of full verbosity output", async () => {
      const { ctx, events } = contextWithEvents();
      const onYield = vi.fn();
      const onAgentToolResult = fullDiagnostics(ctx);
      const args = {
        message: "SYNTHETIC_PRIVATE_CONTINUATION_MARKER",
        acknowledgment: "Research started; results will follow.",
      };
      const tool = createSessionsYieldTool({
        sessionId: ctx.params.sessionId,
        claimYield: () => true,
        onYield,
      });
      const toolCallId = "yield-private-context";
      const toolRef = { toolName: tool.name, toolCallId };

      const result = await runTool(ctx, toolRef, args, () => tool.execute(toolCallId, args));

      expect(onYield).toHaveBeenCalledWith(args.message, args.acknowledgment, undefined);
      expect(events).toHaveLength(6);
      expectProgressVisibility(events, true);
      expect(onAgentToolResult).toHaveBeenCalledWith({
        toolName: tool.name,
        result,
        isError: false,
      });
      expect(ctx.emitToolSummary).toHaveBeenCalledTimes(1);
      expect(ctx.emitToolOutput).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(ctx.emitToolSummary).mock.calls)).not.toContain(args.message);
      expect(JSON.stringify(vi.mocked(ctx.emitToolOutput).mock.calls)).not.toContain(args.message);
      expect(ctx.emitToolOutput).toHaveBeenCalledWith(
        tool.name,
        undefined,
        expect.stringContaining(args.acknowledgment),
        result,
      );
    });

    it("preserves yield failures with explicit hide", async () => {
      const { ctx, events } = contextWithEvents();
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: ctx.params.sessionId,
        claimYield: () => ({ error: "No pending completion" }),
        onYield,
      });
      const toolCallId = "yield-rejected";
      const toolRef = { toolName: tool.name, toolCallId };
      await runTool(ctx, toolRef, {}, () => tool.execute(toolCallId, {}), "start", false);
      const completed = completedEvents(events);
      expect(completed).toHaveLength(2);
      expect(allHidden(completed)).toBe(true);
      expect(ctx.state.lastToolError).toMatchObject({ toolName: tool.name });
      expect(onYield).not.toHaveBeenCalled();
    });
  });
}
