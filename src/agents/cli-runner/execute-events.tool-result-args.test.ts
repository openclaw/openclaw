// Correlated CLI tool results already carry their started args; display-only
// results must not duplicate that potentially large payload.
import { describe, expect, it, vi } from "vitest";
import {
  markMcpLoopbackToolCallStarted,
  updateMcpLoopbackToolCallCapture,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { type AgentEventRuntimePayload, onAgentEvent } from "../../infra/agent-events.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { createCliEventHandlers } from "./execute-events.js";
import { createCliToolTracking, type CliToolTracking } from "./execute-tool-tracking.js";
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
      sessionId: "session-1",
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
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
    beginGatewayCapture: vi.fn(),
  } as unknown as CliToolTracking;
}

function collectToolEvents(runId: string): {
  events: AgentEventRuntimePayload[];
  dispose: () => void;
} {
  const events: AgentEventRuntimePayload[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "tool") {
      events.push(event);
    }
  });
  return { events, dispose };
}

describe("cli tool result events", () => {
  it.each([
    ["poll", "kill", false],
    ["kill", "poll", true],
  ] as const)(
    "uses correlated executed arguments for %s to %s without changing raw arguments",
    (requested, executed, quiet) => {
      const context = buildContext(`rewrite-${requested}`);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(context.params.runId, () => {});
      const handlers = createCliEventHandlers({
        context,
        toolTracking: tracking,
        getRunState: () => ({ failed: false, error: undefined }),
      });
      const events: AgentEventRuntimePayload[] = [];
      const dispose = onAgentEvent((event) => {
        if (event.runId === context.params.runId) {
          events.push(event);
        }
      });
      const args = { action: requested, sessionId: "job" };
      try {
        handlers.emitCliToolUseStart({
          toolCallId: "call",
          name: "mcp__openclaw__process",
          kind: "mcp_tool_use",
          args,
        });
        const capture = markMcpLoopbackToolCallStarted({
          captureKey: context.params.runId,
          toolName: "process",
          args,
        });
        if (!capture) {
          throw new Error("Expected loopback capture");
        }
        updateMcpLoopbackToolCallCapture(capture, {
          toolName: "process",
          args: { ...args, action: executed },
        });
        handlers.emitCliToolResult({
          toolCallId: "call",
          name: "mcp__openclaw__process",
          isError: false,
          result: "result",
        });
        const terminal = events.find(
          (event) => event.stream === "item" && event.data.phase === "end",
        );
        expect(Boolean(terminal?.data.hideFromChannelProgress)).toBe(quiet);
        expect(
          events.find((event) => event.stream === "tool" && event.data.phase === "result")?.data
            .args,
        ).toEqual(args);
      } finally {
        dispose();
        tracking.finalizeCapture(() => {});
      }
    },
  );

  it("projects parsed loopback waits once without changing raw names or display result args", () => {
    const runId = "parsed-activity";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId) {
        events.push(event);
      }
    });
    const parser = createCliJsonlStreamingParser({
      providerId: "claude-cli",
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      onAssistantDelta: vi.fn(),
      onToolUseStart: handlers.emitCliDisplayToolUseStart,
      onToolResult: handlers.emitCliDisplayToolResult,
    });
    try {
      handlers.emitCliCommentaryText("Let me check that for you.");
      expect(events).toMatchObject([
        {
          stream: "item",
          data: { kind: "preamble", phase: "end", progressText: "Let me check that for you." },
        },
      ]);
      for (const [toolCallId, name, args, isError, quiet] of [
        ["poll", "mcp__openclaw__process", { action: "poll", sessionId: "process-1" }, false, true],
        ["failed", "mcp__openclaw__process", { action: "poll", sessionId: "missing" }, true, false],
        [
          "kill",
          "mcp__openclaw__process",
          { action: "kill", sessionId: "process-1" },
          false,
          false,
        ],
        ["yield", "mcp__openclaw__sessions_yield", {}, false, true],
        ["third-party", "mcp__other__sessions_yield", {}, false, false],
      ] as const) {
        parser.push(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: toolCallId, name, input: args }] },
          }) + "\n",
        );
        parser.push(
          JSON.stringify({
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolCallId,
                  content: "raw result",
                  is_error: isError,
                },
              ],
            },
          }) + "\n",
        );
        const operation = events.filter((event) => event.data.toolCallId === toolCallId);
        expect(operation.map((event) => [event.stream, event.data.phase])).toEqual([
          ["item", "start"],
          ["tool", "start"],
          ["tool", "result"],
          ["item", "end"],
        ]);
        expect(operation[2]?.data).toMatchObject({ name, result: "raw result", isError });
        expect(operation[2]?.data.args).toBeUndefined();
        expect(operation[2]?.data.hideFromChannelProgress).toBeUndefined();
        expect(Boolean(operation[3]?.data.hideFromChannelProgress)).toBe(quiet);
        expect(operation[3]?.data.name).toBe(name.replace(/^mcp__openclaw__/, ""));
      }
    } finally {
      dispose();
    }
  });
  it("emits canonical CLI compaction lifecycle events", () => {
    const runId = "run-compaction-events";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "compaction") {
        events.push(event);
      }
    });

    try {
      handlers.emitCliCompaction({ phase: "start" });
      handlers.emitCliCompaction({ phase: "end", completed: true });

      expect(events.map((event) => event.data)).toEqual([
        { phase: "start", backend: "claude-cli" },
        { phase: "end", backend: "claude-cli", completed: true },
      ]);
    } finally {
      dispose();
    }
  });

  it("keeps correlated result args without adding them to display results", () => {
    const runId = "run-tool-result-args";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectToolEvents(runId);

    try {
      handlers.emitCliToolUseStart({
        toolCallId: "call-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "nope-not-a-command" },
      });
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: true,
        result: "bash: nope-not-a-command: command not found",
      });
      handlers.emitCliDisplayToolUseStart({
        toolCallId: "call-2",
        name: "write",
        kind: "tool_use",
        args: { path: "note.txt", content: "hello" },
      });
      handlers.emitCliDisplayToolResult({
        toolCallId: "call-2",
        name: "write",
        isError: false,
        result: "wrote note.txt",
      });
      // The display result also releases correlation state for this call id.
      handlers.emitCliToolResult({
        toolCallId: "call-2",
        name: "write",
        isError: false,
        result: "duplicate terminal",
      });

      const results = events.filter((event) => event.data.phase === "result");
      expect(results[0]?.data.args).toEqual({ command: "nope-not-a-command" });
      expect(results[0]?.data.isError).toBe(true);
      expect(results[1]?.data.args).toBeUndefined();
      expect(results[1]?.data.isError).toBe(false);
      expect(results[2]?.data.args).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("forgets a call's args once it reports, so ids cannot leak across calls", () => {
    const runId = "run-tool-result-args-forget";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectToolEvents(runId);

    try {
      handlers.emitCliToolUseStart({
        toolCallId: "call-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "first" },
      });
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: false,
        result: "",
      });
      // A second result for the same id must not reuse the first call's request.
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: false,
        result: "",
      });

      const results = events.filter((event) => event.data.phase === "result");
      expect(results[0]?.data.args).toEqual({ command: "first" });
      expect(results[1]?.data.args).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
