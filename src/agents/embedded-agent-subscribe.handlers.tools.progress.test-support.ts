import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { onAgentEvent as registerAgentEventListener } from "../infra/agent-events.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
} from "./agent-tools.before-tool-call.state.js";
import { addSession, deleteSession, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

type CapturedAgentEvent = { stream?: string; data?: Record<string, unknown> };
type ToolChannelProgressFixtures = {
  createTestContext: () => { ctx: ToolHandlerContext };
  startTool: (
    ctx: ToolHandlerContext,
    event: Omit<Extract<AgentEvent, { type: "tool_execution_start" }>, "type">,
  ) => void | Promise<void>;
  updateTool: (
    ctx: ToolHandlerContext,
    event: {
      toolName: string;
      toolCallId: string;
      args?: unknown;
      partialResult?: unknown;
      hideFromChannelProgress?: boolean;
    },
  ) => void;
  endTool: (
    ctx: ToolHandlerContext,
    event: Omit<Extract<AgentEvent, { type: "tool_execution_end" }>, "type">,
  ) => ReturnType<typeof handleToolExecutionEnd>;
};

export function registerToolChannelProgressTests({
  createTestContext,
  startTool,
  updateTool,
  endTool,
}: ToolChannelProgressFixtures) {
  describe("process poll channel progress", () => {
    it.each([
      ["poll", "kill"],
      ["poll", "clear"],
      ["kill", "poll"],
      ["clear", "poll"],
    ])(
      "uses executed arguments after a %s to %s hook rewrite",
      async (requestedAction, executedAction) => {
        for (const explicitHide of [false, true]) {
          const { ctx } = createTestContext();
          const events: CapturedAgentEvent[] = [];
          ctx.params.onAgentEvent = (event) => {
            events.push(event);
          };
          const toolCallId = `rewrite-${requestedAction}-${executedAction}-${explicitHide}`;
          const args = { action: requestedAction, sessionId: "fixture" };
          const executedArgs = { ...args, action: executedAction };
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
            updateTool(ctx, { toolName: "process", toolCallId, partialResult: result });
            expect(
              adjustedParamsByToolCallId.get(
                buildAdjustedParamsKey({ runId: ctx.params.runId, toolCallId }),
              ),
            ).toEqual(executedArgs);
            return result;
          });
          const tool = wrapToolWithBeforeToolCallHook(
            { ...createProcessTool(), execute },
            { runId: ctx.params.runId },
          );
          try {
            await startTool(ctx, {
              toolName: "process",
              toolCallId,
              args,
              hideFromChannelProgress: explicitHide,
            });
            const observedResult = await tool.execute(toolCallId, args);
            await endTool(ctx, {
              toolName: "process",
              toolCallId,
              result: observedResult,
              isError: false,
            });
            expect(rewrite).toHaveBeenCalledOnce();
            expect(execute.mock.calls[0]?.[1]).toEqual(executedArgs);
            const start = events.filter((event) => event.data?.phase === "start");
            const settled = events.filter((event) => event.data?.phase !== "start");
            expect(start).toHaveLength(2);
            expect(settled).toHaveLength(4);
            expect(
              start
                .filter((event) => event.stream === "item")
                .every((event) => event.data?.hideFromChannelProgress === true),
            ).toBe(explicitHide || requestedAction === "poll");
            expect(
              settled
                .filter((event) => event.stream === "item")
                .every((event) => event.data?.hideFromChannelProgress === true),
            ).toBe(explicitHide || executedAction === "poll");
            expect(
              events
                .filter((event) => event.stream === "tool")
                .every((event) => Boolean(event.data?.hideFromChannelProgress) === explicitHide),
            ).toBe(true);
            expect(
              adjustedParamsByToolCallId.has(
                buildAdjustedParamsKey({ runId: ctx.params.runId, toolCallId }),
              ),
            ).toBe(false);
          } finally {
            const emptyRegistry = createTestRegistry();
            setActivePluginRegistry(emptyRegistry);
            initializeGlobalHookRunner(emptyRegistry);
          }
        }
      },
    );

    it.each(["off", "on", "full"] as const)(
      "hides successful polls without losing lifecycle or %s diagnostics",
      async (verboseLevel) => {
        const { ctx } = createTestContext();
        ctx.params.onToolResult = vi.fn();
        ctx.shouldEmitToolResult = () => verboseLevel !== "off";
        ctx.shouldEmitToolOutput = () => verboseLevel === "full";
        const onAgentToolResult = vi.fn();
        ctx.params.onAgentToolResult = onAgentToolResult;
        const callbacks: CapturedAgentEvent[] = [];
        const emitted: CapturedAgentEvent[] = [];
        ctx.params.onAgentEvent = (event) => {
          callbacks.push(event);
        };
        const unsubscribe = registerAgentEventListener((event) => emitted.push(event));
        const session = createProcessSessionFixture({ id: "progress-poll", backgrounded: true });
        addSession(session);
        try {
          for (const status of ["running", "completed"] as const) {
            if (status === "completed") {
              markExited(session, 0, null, "completed");
            }
            const toolCallId = `poll-${status}`;
            const args = { action: "poll", sessionId: session.id };
            await startTool(ctx, { toolName: " Process ", toolCallId, args });
            const result = await createProcessTool().execute(toolCallId, args);
            updateTool(ctx, { toolName: "process", toolCallId, partialResult: result });
            await endTool(ctx, { toolName: "process", toolCallId, result, isError: false });
            expect(result.details).toMatchObject({ status });
            expect(onAgentToolResult).toHaveBeenCalledWith({
              toolName: "process",
              result,
              isError: false,
            });
            for (const events of [callbacks, emitted]) {
              const lifecycle = events.filter((event) => event.data?.toolCallId === toolCallId);
              expect(
                lifecycle
                  .filter((event) => event.stream === "tool")
                  .map((event) => event.data?.phase),
              ).toEqual(["start", "update", "result"]);
              expect(
                lifecycle
                  .filter((event) => event.stream === "item")
                  .map((event) => event.data?.phase),
              ).toEqual(["start", "update", "end"]);
              expect(
                lifecycle
                  .filter((event) => event.stream === "item")
                  .every((event) => event.data?.hideFromChannelProgress === true),
              ).toBe(true);
              expect(
                lifecycle
                  .filter((event) => event.stream === "tool")
                  .every((event) => !event.data?.hideFromChannelProgress),
              ).toBe(true);
            }
            expect(emitted).toContainEqual(
              expect.objectContaining({
                stream: "tool",
                data: expect.objectContaining({ toolCallId, phase: "result", result }),
              }),
            );
          }
          expect(ctx.emitToolSummary).toHaveBeenCalledTimes(verboseLevel === "off" ? 0 : 2);
          expect(ctx.emitToolOutput).toHaveBeenCalledTimes(verboseLevel === "full" ? 2 : 0);
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
      },
    );

    it.each(["missing", "nonzero", "timeout"] as const)(
      "exposes a real %s poll failure unless explicitly hidden",
      async (failure) => {
        for (const explicitHide of [undefined, "start", "update", "end"] as const) {
          const { ctx } = createTestContext();
          const events: CapturedAgentEvent[] = [];
          ctx.params.onAgentEvent = (event) => {
            events.push(event);
          };
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
            const args = { action: "poll", sessionId: session.id };
            await startTool(ctx, {
              toolName: "process",
              toolCallId,
              args,
              hideFromChannelProgress: explicitHide === "start",
            });
            const result = await createProcessTool().execute(toolCallId, args);
            updateTool(ctx, {
              toolName: "process",
              toolCallId,
              partialResult: result,
              hideFromChannelProgress: explicitHide === "update",
            });
            await endTool(ctx, {
              toolName: "process",
              toolCallId,
              result,
              isError: false,
              hideFromChannelProgress: explicitHide === "end",
            });
            const completed = events.filter(
              (event) => event.data?.phase === "end" || event.data?.phase === "result",
            );
            expect(completed).toHaveLength(2);
            expect(completed.every((event) => event.data?.hideFromChannelProgress === true)).toBe(
              explicitHide !== undefined,
            );
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

    it.each(["list", "log", "write", "send-keys", "kill", "clear", "remove"])(
      "leaves process %s progress and fallback summaries visible",
      async (action) => {
        const { ctx } = createTestContext();
        const events: CapturedAgentEvent[] = [];
        ctx.params.onAgentEvent = (event) => {
          events.push(event);
        };
        ctx.params.onToolResult = vi.fn();
        ctx.shouldEmitToolResult = () => true;
        const toolCallId = `process-${action}`;
        await startTool(ctx, {
          toolName: "process",
          toolCallId,
          args: { action, sessionId: "sample" },
        });
        updateTool(ctx, { toolName: "process", toolCallId, partialResult: { content: [] } });
        await endTool(ctx, {
          toolName: "process",
          toolCallId,
          isError: false,
          result: { content: [] },
        });
        expect(events).toHaveLength(6);
        expect(events.every((event) => event.data?.hideFromChannelProgress !== true)).toBe(true);
        expect(ctx.emitToolSummary).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("sessions_yield channel progress privacy", () => {
    it.each(["off", "on", "full"] as const)(
      "keeps continuation context out of %s verbosity output",
      async (verboseLevel) => {
        const { ctx } = createTestContext();
        const onYield = vi.fn();
        const events: CapturedAgentEvent[] = [];
        const onAgentToolResult = vi.fn();
        ctx.params.onAgentEvent = (event) => {
          events.push(event);
        };
        ctx.params.onAgentToolResult = onAgentToolResult;
        const args = {
          message: "SYNTHETIC_PRIVATE_CONTINUATION_MARKER",
          acknowledgment: "Research started; results will follow.",
        };
        ctx.params.onToolResult = vi.fn();
        ctx.shouldEmitToolResult = () => verboseLevel !== "off";
        ctx.shouldEmitToolOutput = () => verboseLevel === "full";
        const tool = createSessionsYieldTool({
          sessionId: ctx.params.sessionId,
          claimYield: () => true,
          onYield,
        });
        const toolCallId = "yield-private-context";

        await startTool(ctx, { toolName: tool.name, toolCallId, args });
        const result = await tool.execute(toolCallId, args);
        updateTool(ctx, { toolName: tool.name, toolCallId, partialResult: result });
        await endTool(ctx, { toolName: tool.name, toolCallId, result, isError: false });

        expect(onYield).toHaveBeenCalledWith(args.message, args.acknowledgment);
        expect(events).toHaveLength(6);
        expect(
          events
            .filter((event) => event.stream === "item")
            .every((event) => event.data?.hideFromChannelProgress === true),
        ).toBe(true);
        expect(
          events
            .filter((event) => event.stream === "tool")
            .every((event) => !event.data?.hideFromChannelProgress),
        ).toBe(true);
        expect(onAgentToolResult).toHaveBeenCalledWith({
          toolName: tool.name,
          result,
          isError: false,
        });
        expect(ctx.emitToolSummary).toHaveBeenCalledTimes(verboseLevel === "off" ? 0 : 1);
        expect(ctx.emitToolOutput).toHaveBeenCalledTimes(verboseLevel === "full" ? 1 : 0);
        expect(JSON.stringify(vi.mocked(ctx.emitToolSummary).mock.calls)).not.toContain(
          args.message,
        );
        expect(JSON.stringify(vi.mocked(ctx.emitToolOutput).mock.calls)).not.toContain(
          args.message,
        );
        if (verboseLevel === "full") {
          expect(ctx.emitToolOutput).toHaveBeenCalledWith(
            tool.name,
            undefined,
            expect.stringContaining(args.acknowledgment),
            result,
          );
        }
      },
    );

    it.each([false, true])(
      "preserves yield failures with explicit hide=%s",
      async (explicitHide) => {
        const { ctx } = createTestContext();
        const events: CapturedAgentEvent[] = [];
        const onYield = vi.fn();
        ctx.params.onAgentEvent = (event) => {
          events.push(event);
        };
        const tool = createSessionsYieldTool({
          sessionId: ctx.params.sessionId,
          claimYield: () => ({ error: "No pending completion" }),
          onYield,
        });
        const toolCallId = "yield-rejected";
        await startTool(ctx, {
          toolName: tool.name,
          toolCallId,
          args: {},
          hideFromChannelProgress: explicitHide,
        });
        const result = await tool.execute(toolCallId, {});
        await endTool(ctx, { toolName: tool.name, toolCallId, result, isError: false });
        const completed = events.filter(
          (event) => event.data?.phase === "end" || event.data?.phase === "result",
        );
        expect(completed).toHaveLength(2);
        expect(completed.every((event) => event.data?.hideFromChannelProgress === true)).toBe(
          explicitHide,
        );
        expect(ctx.state.lastToolError).toMatchObject({ toolName: tool.name });
        expect(onYield).not.toHaveBeenCalled();
      },
    );
  });
}
