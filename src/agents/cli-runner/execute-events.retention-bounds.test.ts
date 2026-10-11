// A spent turn budget no longer stops the parser from delivering tool events, so
// the run-scoped maps `createCliEventHandlers` keeps are now reached for as long
// as the CLI process lives. These pin the bounds on them — and the last test is
// the control: it passes on the unbounded tree too, so the three above it are
// measuring the newly bounded path rather than one that was already capped.
import { describe, expect, it, vi } from "vitest";
import type { AgentEventRuntimePayload } from "../../infra/agent-events.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  MAX_RETAINED_TOOL_ARG_CHARS,
  MAX_TRACKED_TOOL_SUMMARIES,
  MAX_UNFINISHED_TOOL_CALLS,
} from "./execute-event-retention.js";
import { createCliEventHandlers } from "./execute-events.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

function buildContext(runId: string): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-retention",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      timeoutMs: 1_000,
      runId,
    },
    started: Date.now(),
    startedMonotonicMs: performance.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    executionTarget: { kind: "process" },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-haiku-4-5",
    normalizedModel: "claude-haiku-4-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  } as PreparedCliRunContext;
}

function buildToolTracking(): CliToolTracking {
  return {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(() => undefined),
    dropRetainedToolArgs: vi.fn(),
    getRetainedMessagingSizes: vi.fn(() => ({
      pendingMessagingCalls: 0,
      reducedMessagingCalls: 0,
      reducedMessagingArgChars: 0,
    })),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
    beginGatewayCapture: vi.fn(),
  } as unknown as CliToolTracking;
}

function buildHandlers(runId: string) {
  const toolTracking = buildToolTracking();
  const handlers = createCliEventHandlers({
    context: buildContext(runId),
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const events: AgentEventRuntimePayload[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "tool") {
      events.push(event);
    }
  });
  return { handlers, toolTracking, events, dispose };
}

type Handlers = ReturnType<typeof createCliEventHandlers>;

function startTool(handlers: Handlers, toolCallId: string, args: Record<string, unknown>): void {
  handlers.emitParsedToolUseStart({ toolCallId, name: "Bash", kind: "tool_use", args });
}

function finishTool(handlers: Handlers, toolCallId: string): void {
  handlers.emitParsedToolResult({ toolCallId, name: "Bash", isError: false, result: "ok" });
}

function resultArgsFor(events: AgentEventRuntimePayload[], toolCallId: string): unknown {
  return events.find(
    (event) => event.data.phase === "result" && event.data.toolCallId === toolCallId,
  )?.data.args;
}

describe("cli event handler retention bounds", () => {
  it("bounds the arguments retained for tool calls whose result never arrives", () => {
    const { handlers, toolTracking, events, dispose } = buildHandlers("retention-args");
    // 2 MiB of arguments per call, five calls still outstanding: 10 MiB against
    // an 8 MiB bound, with the count cap far out of reach so it cannot be what
    // holds.
    const argChars = 2 * 1024 * 1024;
    const calls = 5;
    try {
      for (let index = 0; index < calls; index += 1) {
        startTool(handlers, `call-${index}`, { command: "x".repeat(argChars) });
      }
      expect(argChars * calls).toBeGreaterThan(MAX_RETAINED_TOOL_ARG_CHARS);
      // Behavioral first, so an unbounded build fails on an observation rather
      // than on a missing accessor: the first call still echoes its real
      // arguments, a call past the bound echoes none.
      finishTool(handlers, "call-0");
      finishTool(handlers, `call-${calls - 1}`);
      expect(resultArgsFor(events, "call-0")).toEqual({ command: "x".repeat(argChars) });
      expect(resultArgsFor(events, `call-${calls - 1}`)).toEqual({});
      // The other holder of the same decoded object was told to let go as well;
      // releasing only one of them would free nothing.
      expect(toolTracking.dropRetainedToolArgs).toHaveBeenCalled();
      const retained = handlers.getRetainedStateSizes();
      expect(retained.unfinishedToolCalls).toBeLessThan(MAX_UNFINISHED_TOOL_CALLS);
      expect(retained.retainedToolArgChars).toBeLessThanOrEqual(MAX_RETAINED_TOOL_ARG_CHARS);
    } finally {
      dispose();
    }
  });

  it("bounds how many unfinished tool calls are tracked at once", () => {
    const { handlers, events, dispose } = buildHandlers("retention-unfinished");
    const calls = MAX_UNFINISHED_TOOL_CALLS * 2;
    try {
      for (let index = 0; index < calls; index += 1) {
        // The parsed path, so the diagnostic-side map is exercised too.
        handlers.emitParsedToolUseStart({
          toolCallId: `call-${index}`,
          name: "Bash",
          kind: "tool_use",
          args: { command: `run ${index}` },
        });
      }
      // Behavioral first, for the same reason: the newest call keeps its
      // correlation, while the oldest was released and its result therefore
      // carries no argument echo at all.
      finishTool(handlers, "call-0");
      finishTool(handlers, `call-${calls - 1}`);
      expect(resultArgsFor(events, "call-0")).toBeUndefined();
      expect(resultArgsFor(events, `call-${calls - 1}`)).toEqual({ command: `run ${calls - 1}` });
      const retained = handlers.getRetainedStateSizes();
      expect(retained.unfinishedToolCalls).toBeLessThanOrEqual(MAX_UNFINISHED_TOOL_CALLS);
      expect(retained.activeParsedTools).toBeLessThanOrEqual(MAX_UNFINISHED_TOOL_CALLS);
    } finally {
      dispose();
    }
  });

  it("bounds retained tool summaries while keeping the summary counts exact", () => {
    const { handlers, dispose } = buildHandlers("retention-summaries");
    const calls = MAX_TRACKED_TOOL_SUMMARIES + 512;
    try {
      for (let index = 0; index < calls; index += 1) {
        startTool(handlers, `call-${index}`, {});
        handlers.emitParsedToolResult({
          toolCallId: `call-${index}`,
          name: "Bash",
          isError: index % 2 === 0,
          result: "ok",
        });
      }
      expect(handlers.getRetainedStateSizes().toolSummaries).toBeLessThanOrEqual(
        MAX_TRACKED_TOOL_SUMMARIES,
      );
      // Eviction costs recent-call dedup, never the trace the run reports.
      expect(handlers.getToolSummary()).toEqual({
        calls,
        tools: ["Bash"],
        failures: calls / 2,
      });
    } finally {
      dispose();
    }
  });

  it("does not degrade an ordinary turn that stays well inside every bound", () => {
    // Control: this passes on the unbounded tree too.
    const { handlers, toolTracking, events, dispose } = buildHandlers("retention-control");
    try {
      for (let index = 0; index < 8; index += 1) {
        startTool(handlers, `call-${index}`, { command: `run ${index}` });
      }
      for (let index = 0; index < 8; index += 1) {
        finishTool(handlers, `call-${index}`);
      }
      expect(resultArgsFor(events, "call-0")).toEqual({ command: "run 0" });
      expect(resultArgsFor(events, "call-7")).toEqual({ command: "run 7" });
      expect(handlers.getToolSummary()).toEqual({ calls: 8, tools: ["Bash"], failures: 0 });
      expect(toolTracking.dropRetainedToolArgs).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
