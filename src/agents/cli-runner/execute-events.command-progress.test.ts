import { expect, it, vi } from "vitest";
import {
  buildChannelProgressDraftLine,
  mergeChannelProgressDraftLine,
} from "../../channels/streaming.js";
import {
  markMcpLoopbackRequestStarted,
  markMcpLoopbackRequestFinished,
  resolveMcpLoopbackYieldContext,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createDiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import { createSessionControllerWatchdog } from "../../sessions/session-controller.watchdog.js";
import type { CliToolUseStartDelta } from "../cli-output-contracts.js";
import {
  claudeMessageStart,
  claudeStreamEvent,
  claudeTextDelta,
  createClaudeParser,
  joinJsonlFrames,
} from "../cli-output.test-helpers.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import { createCliToolTracking, type CliToolTracking } from "./execute-tool-tracking.js";

it("keeps native Bash detail without asserting ambiguous MCP execution", () => {
  const runId = "cli-bash-progress";
  const context = buildContext(runId);
  const tracking = {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
  } as unknown as CliToolTracking;
  const handlers = createCliEventHandlers({
    context,
    toolTracking: tracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId) {
      events.push(event);
    }
  });
  const complete = (
    toolCallId: string,
    name: string,
    kind: CliToolUseStartDelta["kind"],
    command: string,
    result: string,
  ) => {
    handlers.emitParsedToolUseStart({ toolCallId, name, kind, args: { command } });
    handlers.emitParsedToolResult({ toolCallId, name, isError: false, result });
  };
  try {
    complete("bash-1", "Bash", "tool_use", "echo retained", "retained");

    const start = events.find((event) => event.stream === "tool" && event.data.phase === "start");
    const end = events.find((event) => event.stream === "item" && event.data.phase === "end");
    expect(end?.data).toMatchObject({
      status: "completed",
      meta: expect.stringContaining("echo retained"),
    });
    const options = { commandText: "raw" as const, detailMode: "raw" as const };
    const startLine = buildChannelProgressDraftLine(
      {
        event: "tool",
        name: "Bash",
        toolCallId: "bash-1",
        args: start?.data.args as Record<string, unknown>,
      },
      options,
    );
    const endLine = buildChannelProgressDraftLine(
      {
        event: "item",
        name: "Bash",
        toolCallId: "bash-1",
        itemId: "tool:bash-1",
        itemKind: "tool",
        status: "completed",
        commandBearing: true,
        meta: end?.data.meta as string | undefined,
      },
      options,
    );
    if (!startLine || !endLine) {
      throw new Error("expected Bash progress lines");
    }
    expect(
      mergeChannelProgressDraftLine([startLine], endLine, { maxLines: 4 })[0]?.detail,
    ).toContain("echo retained");

    for (const [toolCallId, name, expectedName, kind] of [
      ["mcp-1", "mcp__openclaw__exec", "exec", "mcp_tool_use"],
      ["mcp-generic-1", "mcp__openclaw__exec", "exec", "tool_use"],
      ["mcp-gemini-1", "mcp_openclaw_exec", "exec", "tool_use"],
      ["mcp-third-party-1", "mcp_docs_exec", "mcp_docs_exec", "tool_use"],
    ] as const) {
      complete(toolCallId, name, kind, "requested command", "result with ambiguous execution");
      const mcpTerminal = events.find(
        (event) =>
          event.stream === "item" &&
          event.data.phase === "end" &&
          event.data.toolCallId === toolCallId,
      );
      expect(mcpTerminal?.data).toMatchObject({ status: "completed", name: expectedName });
      expect(mcpTerminal?.data.meta).toBeUndefined();
    }
  } finally {
    dispose();
  }
});

const thinking = (text: string, tokens?: number) =>
  claudeStreamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: text, estimated_tokens: tokens },
  });
const snapshot = (text: string) => ({
  type: "assistant",
  message: { id: "message-a", content: [{ type: "thinking", thinking: text }] },
});
it.each([
  ["text", [thinking("New analysis")], true],
  ["tokens after message reset", [claudeMessageStart("message-b"), thinking("", 1)], true],
  ["assistant control", [claudeTextDelta("Visible answer")], true],
  ["non-prefix revision", [snapshot("Revised analysis")], true],
  ["repeated snapshot", [snapshot("Known analysis")], false],
  ["prefix snapshot", [snapshot("Known")], false],
  ["replay after prefix", [snapshot("Known"), snapshot("Known analysis")], false],
  ["heartbeat", [{ type: "keep_alive" }], false],
  ["zero tokens", [thinking("", 0)], false],
  ["unqualified text", [], false],
  ["unqualified tokens", [], false],
  ["subagent", [{ ...thinking("Child analysis"), parent_tool_use_id: "child" }], false],
  ["stale attempt", [thinking("Old attempt")], false],
  ["active tool", [thinking("While tool runs")], false],
  ["yielded text", [thinking("After yield")], false],
  ["yielded tokens", [thinking("", 1)], false],
] as const)(
  "classifies %s through the real JSONL/handler/watchdog path",
  async (kind, frames, advances) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stop = vi.fn(() => "settled" as const);
    const watchdog = createSessionControllerWatchdog({
      startedAtMs: 0,
      isCurrent: () => true,
      readPhase: () => "active",
      requestStop: stop,
      expireCleanup: stop,
    });
    const attempt = watchdog.attachAttempt({ assertCurrent() {} });
    attempt.setExecutionDeadline(600_000);
    const context = buildContext("thinking-progress");
    context.params.diagnosticOwner = createDiagnosticEmbeddedRunOwner({
      ...context.params,
      watchdogAttempt: attempt,
    });
    const tracking = createCliToolTracking(context);
    const handlers = createCliEventHandlers({
      context,
      toolTracking: tracking,
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const parser = createClaudeParser({
      onAssistantDelta: handlers.emitCliAssistantDelta,
      onThinkingDelta: handlers.emitCliThinkingDelta,
      onThinkingProgress: handlers.emitCliThinkingProgress,
    });
    const push = (...records: unknown[]) => parser.push(joinJsonlFrames(...records, ""));
    const displayed: Record<string, unknown>[] = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === context.params.runId && event.stream === "thinking") {
        displayed.push(event.data);
      }
    });
    try {
      push(claudeMessageStart("message-a"), thinking("Known analysis"), thinking("", 100));
      vi.setSystemTime(359_000);
      if (kind === "stale attempt") {
        watchdog.attachAttempt({ assertCurrent() {} });
      }
      const endTool =
        kind === "active tool"
          ? attempt.beginTool({ toolCallId: "tool", toolName: "exec" })
          : undefined;
      if (kind.startsWith("yielded")) {
        tracking.registerTurnInterrupt({ interrupt: async () => {} });
        tracking.beginGatewayCapture("thinking-yield", () => {});
        const request = markMcpLoopbackRequestStarted("thinking-yield");
        await resolveMcpLoopbackYieldContext(request)!.onYield("yield");
        markMcpLoopbackRequestFinished(request);
        expect(tracking.shouldSuppressAssistantOutput()).toBe(true);
      }
      if (kind === "unqualified text") {
        handlers.emitCliThinkingDelta({
          text: "Display only",
          delta: "Display only",
          isReasoningSnapshot: true,
        });
        expect(displayed.at(-1)).toEqual({
          text: "Display only",
          delta: "Display only",
          isReasoningSnapshot: true,
        });
      } else if (kind === "unqualified tokens") {
        handlers.emitCliThinkingProgress({ progressTokens: 123 });
        expect(displayed.at(-1)).toEqual({ progressTokens: 123 });
      }
      push(...frames);
      vi.setSystemTime(360_000);
      expect(watchdog.snapshot().semanticDeadlineAtMs).toBe(advances ? 719_000 : 360_000);
      if (endTool) {
        expect((await watchdog.tick()).action).toBe("warn");
        expect(stop).not.toHaveBeenCalled();
        endTool();
      }
      expect(await watchdog.tick()).toMatchObject({
        action: advances ? "observe" : "stop",
        reason: advances ? "progress" : "semantic_stall",
      });
      if (advances) {
        expect(stop).not.toHaveBeenCalled();
        vi.setSystemTime(600_000);
        expect(await watchdog.tick()).toMatchObject({
          action: "stop",
          reason: "execution_deadline",
        });
      }
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      dispose();
      tracking.finalizeCapture(() => {});
      watchdog.close();
      vi.useRealTimers();
    }
  },
);
