// Correlated CLI tool results already carry their started args; display-only
// results must not duplicate that potentially large payload.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCliToolSummaryTracker,
  runCliAgentWithLifecycle,
} from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
import type { GetReplyOptions } from "../../auto-reply/types.js";
import { createChannelProgressDraftCompositor } from "../../channels/progress-draft-compositor.js";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  updateMcpLoopbackToolCallCapture,
} from "../../gateway/mcp-http.loopback-runtime.js";
import {
  type AgentEventRuntimePayload,
  emitAgentEvent,
  onAgentEvent,
} from "../../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { createCliEventHandlers } from "./execute-events.js";
import { createCliToolTracking, type CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const cliDispatchState = vi.hoisted(() => ({ runCliAgentMock: vi.fn() }));
vi.mock("../cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));
afterEach(() => {
  cliDispatchState.runCliAgentMock.mockReset();
  resetGlobalHookRunner();
});

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
    if (event.runId === runId && (event.stream === "tool" || event.stream === "item")) {
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

  it.each([false, true])(
    "delivers native completions once to canonical matchers unless isolated (%s)",
    async (isolatedCompletion) => {
      const observed: unknown[] = [];
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "after_tool_call",
            matcher: ["exec", "web_fetch"],
            handler: (event) => observed.push(event),
          },
        ]),
      );
      const context = buildContext(`native-completion-${isolatedCompletion}`);
      if (isolatedCompletion) {
        context.params.isolatedCompletion = true;
      }
      const handlers = createCliEventHandlers({
        context,
        toolTracking: createCliToolTracking(context),
        getRunState: () => ({ failed: false, error: undefined }),
      });
      handlers.emitCliToolUseStart({
        toolCallId: "native-exec",
        name: "Bash",
        kind: "tool_use",
        args: { command: "pwd" },
      });
      const completed = {
        toolCallId: "native-exec",
        name: "Bash",
        isError: false,
        result: "/workspace",
      };
      handlers.emitCliToolResult(completed);
      handlers.emitCliToolResult(completed);
      handlers.emitCliDisplayToolUseStart({
        toolCallId: "native-fetch",
        name: "WebFetch",
        kind: "tool_use",
        args: { url: "https://example.com" },
      });
      handlers.emitCliDisplayToolResult({
        toolCallId: "native-fetch",
        name: "WebFetch",
        isError: true,
        result: { error: "request failed" },
      });
      for (const name of ["mcp__openclaw__exec", "mcp_openclaw_exec"]) {
        handlers.emitCliToolUseStart({
          toolCallId: name,
          name,
          kind: "mcp_tool_use",
          args: { command: "pwd" },
        });
        handlers.emitCliToolResult({ ...completed, toolCallId: name, name });
      }
      handlers.emitCliToolResult({ ...completed, toolCallId: "unknown-call", name: "" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await vi.waitFor(() =>
        expect(observed).toMatchObject(
          isolatedCompletion
            ? []
            : [
                {
                  toolName: "exec",
                  toolCallId: "native-exec",
                  params: { command: "pwd" },
                  result: "/workspace",
                },
                {
                  toolName: "web_fetch",
                  toolCallId: "native-fetch",
                  params: { url: "https://example.com" },
                  error: "request failed",
                },
              ],
        ),
      );
    },
  );

  it("keeps named result-only completions and duplicate claims scoped to their parser run", async () => {
    const observed: unknown[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          matcher: ["exec"],
          handler: (event) => observed.push(event),
        },
      ]),
    );
    const parsers = ["previous", "current"].map((runId) => {
      const context = buildContext(runId);
      const handlers = createCliEventHandlers({
        context,
        toolTracking: createCliToolTracking(context),
        getRunState: () => ({ failed: false, error: undefined }),
      });
      return createCliJsonlStreamingParser({
        backend: { command: "synthetic", output: "jsonl" },
        providerId: "synthetic-cli",
        parseJsonlEvent: (line) => ({
          kind: "toolResult",
          toolCallId: "reused-id",
          name: "Bash",
          result: line.trim(),
        }),
        onAssistantDelta: () => {},
        onDisplayToolResult: handlers.emitCliDisplayToolResult,
      });
    });
    parsers[1]?.push('{"output":"current"}\n{"output":"duplicate"}\n');
    parsers[0]?.push('{"output":"late previous"}\n');
    await vi.waitFor(() =>
      expect(observed).toMatchObject([
        {
          toolName: "exec",
          runId: "current",
          toolCallId: "reused-id",
          params: {},
          result: '{"output":"current"}',
        },
        {
          toolName: "exec",
          runId: "previous",
          toolCallId: "reused-id",
          params: {},
          result: '{"output":"late previous"}',
        },
      ]),
    );
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
      // Native tools report no executed args; the terminal row keeps the started command.
      const [started, ended] = events.filter((event) => event.data.itemId === "tool:call-1");
      expect(started?.data.meta).toEqual(expect.stringContaining("nope-not-a-command"));
      expect(ended?.data).toMatchObject({ status: "failed", title: started?.data.title });
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

describe("CLI progress-card plan projection", () => {
  it.each(["replacement", "clear", "ambiguous"] as const)(
    "projects only unambiguous executed progress-card arguments: %s",
    (mode) => {
      const runId = `executed-plan-${mode}`;
      const context = buildContext(runId);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(runId, () => {});
      const handlers = createCliEventHandlers({
        context,
        toolTracking: tracking,
        getRunState: () => ({ failed: false, error: undefined }),
      });
      const events: AgentEventRuntimePayload[] = [];
      const dispose = onAgentEvent((event) => {
        if (event.runId === runId) {
          events.push(event);
        }
      });
      const plan = { plan: [{ step: "Prepared checklist", status: "in_progress" }] };
      const requested = mode === "replacement" ? {} : plan;
      const executed = mode === "clear" ? {} : plan;
      const name = "mcp__openclaw__progress_card";
      try {
        handlers.emitCliToolUseStart({
          toolCallId: "card",
          name,
          kind: "mcp_tool_use",
          args: requested,
        });
        if (mode === "ambiguous") {
          handlers.emitCliToolUseStart({
            toolCallId: "peer",
            name,
            kind: "mcp_tool_use",
            args: requested,
          });
        }
        const capture = markMcpLoopbackToolCallStarted({
          captureKey: runId,
          toolName: "progress_card",
          args: requested,
        });
        if (!capture) {
          throw new Error("Expected loopback capture");
        }
        updateMcpLoopbackToolCallCapture(capture, { toolName: "progress_card", args: executed });
        recordMcpLoopbackToolCallResult({
          captureHandle: capture,
          toolName: "progress_card",
          args: executed,
          outcome: "completed",
        });
        markMcpLoopbackToolCallFinished(capture);
        handlers.emitCliToolResult({ toolCallId: "card", name, isError: false });
        const plans = events.filter((event) => event.stream === "plan");
        if (mode === "ambiguous") {
          expect(plans).toEqual([]);
        } else {
          expect(plans).toHaveLength(1);
          expect(plans[0]?.data.steps).toEqual(mode === "clear" ? [] : plan.plan);
        }
        expect(
          events.find((event) => event.stream === "tool" && event.data.phase === "result")?.data
            .args,
        ).toEqual(requested);
      } finally {
        dispose();
        tracking.finalizeCapture(() => {});
      }
    },
  );

  it.each([
    ["progress_card", false],
    ["mcp__openclaw__progress_card", false],
    ["progress_card", true],
    ["mcp__openclaw__progress_card", true],
  ] as const)(
    "keeps parsed display-only %s clears outside tracked plan state (tracked result first: %s)",
    (name, trackedResultFirst) => {
      const runId = `display-clear-${name}`;
      const tracking = buildToolTracking();
      const handlers = createCliEventHandlers({
        context: buildContext(runId),
        toolTracking: tracking,
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
        handlers.emitCliToolUseStart({
          toolCallId: "tracked-plan",
          name,
          kind: "mcp_tool_use",
          args: { plan: [{ step: "Keep working", status: "in_progress" }] },
        });
        handlers.emitCliToolResult({ toolCallId: "tracked-plan", name, isError: false });
        parser.push(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "display-clear", name, input: {} }] },
          }) + "\n",
        );
        if (trackedResultFirst) {
          handlers.emitCliToolResult({ toolCallId: "display-clear", name, isError: false });
        }
        parser.push(
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "display-clear", content: "done" }],
            },
          }) + "\n",
        );
        // Neither ordering may promote a display-only start into authoritative plan state.
        if (!trackedResultFirst) {
          handlers.emitCliToolResult({ toolCallId: "display-clear", name, isError: false });
        }
        const plans = () => events.filter((event) => event.stream === "plan");
        expect(plans()).toHaveLength(1);
        expect(plans()[0]?.data.steps).toEqual([{ step: "Keep working", status: "in_progress" }]);
        expect(tracking.handleCliToolUseStart).toHaveBeenCalledTimes(1);
        expect(tracking.handleCliToolResult).toHaveBeenCalledTimes(2);
        handlers.emitCliToolUseStart({
          toolCallId: "tracked-clear",
          name,
          kind: "mcp_tool_use",
          args: {},
        });
        handlers.emitCliToolResult({ toolCallId: "tracked-clear", name, isError: false });
        expect(plans()).toHaveLength(2);
        expect(plans()[1]?.data.steps).toEqual([]);
        expect(handlers.getToolSummary()).toEqual({ calls: 3, tools: [name], failures: 0 });
      } finally {
        dispose();
      }
    },
  );

  it.each([
    "progress_card",
    "mcp__openclaw__progress_card",
    "update_plan",
    "mcp__openclaw__update_plan",
  ])("projects normalized %s input once while preserving activity order", (name) => {
    const runId = `plan-${name}`;
    const context = buildContext(runId);
    context.resultContentSourceByToolName = new Map([["progress_card", "network"]]);
    const tracking = buildToolTracking();
    const handlers = createCliEventHandlers({
      context,
      toolTracking: tracking,
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId) {
        events.push(event);
      }
    });
    const args = {
      plan: [
        { step: "Inspect\u200b", status: "completed" },
        { step: "Repair", status: "in_progress" },
      ],
    };
    try {
      handlers.emitCliToolUseStart({ toolCallId: "card", name, kind: "mcp_tool_use", args });
      handlers.emitCliToolResult({ toolCallId: "card", name, isError: false, result: "updated" });
      const plan = events.filter((event) => event.stream === "plan");
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({
        runId,
        data: {
          phase: "update",
          title: "Plan updated",
          source: "openclaw",
          explanation: "1/2 complete",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Repair", status: "in_progress" },
          ],
        },
      });
      expect(
        events
          .filter((event) => event.stream !== "plan")
          .map((event) => [event.stream, event.data.phase]),
      ).toEqual([
        ["item", "start"],
        ["tool", "start"],
        ["tool", "result"],
        ["item", "end"],
      ]);
      const result = events.find(
        (event) => event.stream === "tool" && event.data.phase === "result",
      );
      expect(result?.data).toMatchObject({ name, args, result: "updated", isError: false });
      if (name.endsWith("progress_card")) {
        expect(result?.data.resultContentSource).toBe("network");
      }
      handlers.emitCliToolResult({ toolCallId: "card", name, isError: false, result: "duplicate" });
      expect(events.filter((event) => event.stream === "plan")).toHaveLength(1);
      expect(tracking.handleCliToolResult).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });

  it.each([
    {
      label: "failed",
      name: "progress_card",
      args: { plan: [{ step: "Inspect", status: "pending" }] },
      failed: true,
    },
    { label: "malformed", name: "progress_card", args: { plan: "not a plan" } },
    {
      label: "invalid status",
      name: "progress_card",
      args: { plan: [{ step: "Inspect", status: "invented" }] },
    },
    { label: "unrelated", name: "exec", args: { plan: [{ step: "Inspect", status: "pending" }] } },
    {
      label: "other MCP server",
      name: "mcp__other__progress_card",
      args: { plan: [{ step: "Inspect", status: "pending" }] },
    },
    {
      label: "uncorrelated",
      name: "progress_card",
      args: { plan: [{ step: "Inspect", status: "pending" }] },
      skipStart: true,
    },
    {
      label: "side question",
      name: "progress_card",
      args: { plan: [{ step: "Inspect", status: "pending" }] },
      sideQuestion: true,
    },
    {
      label: "display only",
      name: "progress_card",
      args: { plan: [{ step: "Inspect", status: "pending" }] },
      displayOnly: true,
    },
  ])(
    "does not fabricate plan state for $label results",
    ({ name, args, failed, skipStart, sideQuestion, displayOnly }) => {
      const runId = "no-plan";
      const context = buildContext(runId);
      if (sideQuestion) {
        context.params.executionMode = "side-question";
      }
      const handlers = createCliEventHandlers({
        context,
        toolTracking: buildToolTracking(),
        getRunState: () => ({ failed: false, error: undefined }),
      });
      const events: AgentEventRuntimePayload[] = [];
      const dispose = onAgentEvent((event) => {
        if (event.runId === runId) {
          events.push(event);
        }
      });
      try {
        const start = { toolCallId: "card", name, kind: "mcp_tool_use" as const, args };
        if (!skipStart) {
          if (displayOnly) {
            handlers.emitCliDisplayToolUseStart(start);
          } else {
            handlers.emitCliToolUseStart(start);
          }
        }
        const result = { toolCallId: "card", name, isError: failed === true, result: "receipt" };
        if (displayOnly) {
          handlers.emitCliDisplayToolResult(result);
        } else {
          handlers.emitCliToolResult(result);
        }
        expect(events.filter((event) => event.stream === "plan")).toEqual([]);
        if (sideQuestion) {
          expect(events).toEqual([]);
        }
      } finally {
        dispose();
      }
    },
  );
});

describe("CLI plan channel bridge", () => {
  it.each([
    { name: "progress_card", suppressed: false, clearCard: false },
    { name: "mcp__openclaw__progress_card", suppressed: false, clearCard: false },
    { name: "mcp__openclaw__progress_card", suppressed: true, clearCard: false },
    { name: "progress_card", suppressed: false, clearCard: true },
    { name: "mcp__openclaw__progress_card", suppressed: false, clearCard: true },
    { name: "update_plan", suppressed: false, clearCard: true },
    { name: "mcp__openclaw__update_plan", suppressed: false, clearCard: true },
    { name: "mcp__openclaw__progress_card", suppressed: true, clearCard: true },
  ])(
    "bridges $name with suppression=$suppressed and clear=$clearCard without completing the run",
    async ({ name, suppressed, clearCard }) => {
      const runId = `progress-bridge-${name}`;
      const render = vi.fn((_text: string, _options?: unknown) => true);
      const deleteCurrent = vi.fn(async () => {});
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: false, toolProgress: true } } },
        mode: "progress",
        active: true,
        seed: runId,
        update: render,
        deleteCurrent,
      });
      const onPlanUpdate = vi.fn(
        async (update: Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0]) => {
          await progress.pushPlanProgress(update.steps ?? [], update);
        },
      );
      const lifecycle: string[] = [];
      const dispose = onAgentEvent((event) => {
        if (event.runId === runId && event.stream === "lifecycle") {
          lifecycle.push(String(event.data.phase));
        }
      });
      cliDispatchState.runCliAgentMock.mockImplementationOnce(
        async (params: PreparedCliRunContext["params"]) => {
          const handlers = createCliEventHandlers({
            context: { ...buildContext(runId), params },
            toolTracking: buildToolTracking(),
            getRunState: () => ({ failed: false, error: undefined }),
          });
          const parser = createCliJsonlStreamingParser({
            providerId: "claude-cli",
            backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
            onAssistantDelta: handlers.emitCliAssistantDelta,
            onToolUseStart: handlers.emitParsedToolUseStart,
            onToolResult: handlers.emitParsedToolResult,
          });
          parser.push(
            JSON.stringify({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "plan",
                    name,
                    input: {
                      plan: [
                        { step: "Inspect\u200b", status: "completed" },
                        { step: "Repair", status: "completed" },
                      ],
                    },
                  },
                ],
              },
            }) + "\n",
          );
          const resultLine =
            JSON.stringify({
              type: "user",
              message: {
                content: [
                  { type: "tool_result", tool_use_id: "plan", content: "updated", is_error: false },
                ],
              },
            }) + "\n";
          parser.push(resultLine);
          parser.push(resultLine);
          if (clearCard) {
            const call = (id: string, input: Record<string, unknown>) => {
              parser.push(
                JSON.stringify({
                  type: "assistant",
                  message: { content: [{ type: "tool_use", id, name, input }] },
                }) + "\n",
              );
              return (
                JSON.stringify({
                  type: "user",
                  message: {
                    content: [
                      { type: "tool_result", tool_use_id: id, content: "updated", is_error: false },
                    ],
                  },
                }) + "\n"
              );
            };
            const clearResult = call("clear", {});
            parser.push(clearResult);
            parser.push(clearResult);
            parser.push(
              call("replacement", {
                plan: [{ step: "Replacement", status: "in_progress" }],
              }),
            );
            // A late duplicate clear must not retract the newer checklist.
            parser.push(clearResult);
          }
          emitAgentEvent({
            runId: "unrelated-run",
            stream: "plan",
            data: { steps: ["Do not deliver"] },
          });
          expect(lifecycle).not.toContain("end");
          return { payloads: [{ text: "Final task answer" }], meta: { durationMs: 1 } };
        },
      );
      try {
        const result = await runCliAgentWithLifecycle({
          runId,
          provider: "claude-cli",
          onPlanUpdate,
          suppressAssistantBridge: suppressed,
          runParams: buildContext(runId).params,
        });
        expect(onPlanUpdate).toHaveBeenCalledTimes(suppressed ? 0 : clearCard ? 3 : 1);
        if (!suppressed) {
          expect(onPlanUpdate).toHaveBeenCalledWith({
            phase: "update",
            title: "Plan updated",
            explanation: "2/2 complete",
            source: "openclaw",
            steps: [
              { step: "Inspect", status: "completed" },
              { step: "Repair", status: "completed" },
            ],
          });
        }
        if (suppressed) {
          expect(render).not.toHaveBeenCalled();
          expect(deleteCurrent).not.toHaveBeenCalled();
        } else {
          expect(render).toHaveBeenCalledWith(
            expect.stringContaining("2/2 complete"),
            expect.objectContaining({
              snapshot: expect.objectContaining({
                plan: [
                  { step: "Inspect", status: "completed" },
                  { step: "Repair", status: "completed" },
                ],
              }),
            }),
          );
          const rendered = render.mock.calls.at(-1)?.[0];
          if (clearCard) {
            expect(onPlanUpdate).toHaveBeenNthCalledWith(2, {
              phase: "update",
              title: "Plan updated",
              source: "openclaw",
              steps: [],
            });
            expect(onPlanUpdate).toHaveBeenNthCalledWith(
              3,
              expect.objectContaining({
                steps: [{ step: "Replacement", status: "in_progress" }],
              }),
            );
            expect(deleteCurrent).toHaveBeenCalledTimes(1);
            expect(rendered).toContain("Replacement");
            expect(rendered).not.toContain("Inspect");
          } else {
            expect(deleteCurrent).not.toHaveBeenCalled();
            expect(rendered).toContain("Inspect");
            expect(rendered).toContain("Repair");
          }
        }
        expect(result.payloads).toEqual([{ text: "Final task answer" }]);
        expect(lifecycle).toEqual(["start", "end"]);
      } finally {
        progress.cancel();
        dispose();
      }
    },
  );

  it.each([
    "progress_card",
    "mcp__openclaw__progress_card",
    "update_plan",
    "mcp__openclaw__update_plan",
    "mcp__other__progress_card",
  ])("retains %s failure receipts and stored-name lookup", async (name) => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent({ name, phase: "start", args: {}, toolCallId: "failed-plan" });
    const commandBearing = await tracker.noteToolEvent({
      name: undefined,
      phase: "result",
      args: undefined,
      toolCallId: "failed-plan",
      isError: true,
      result: "write failed",
    });
    expect(commandBearing).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({
      text: expect.stringContaining("write failed"),
      isError: true,
    });
  });
});
