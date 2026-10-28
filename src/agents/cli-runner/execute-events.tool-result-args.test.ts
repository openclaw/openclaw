// Correlated CLI tool results already carry their started args; display-only
// results must not duplicate that potentially large payload.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runCliAgentWithLifecycle } from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
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
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const cliDispatchState = vi.hoisted(() => ({ runCliAgentMock: vi.fn() }));
vi.mock("../cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));
afterEach(() => {
  cliDispatchState.runCliAgentMock.mockReset();
  resetGlobalHookRunner();
});

function eventFixture(context: PreparedCliRunContext, tracking = buildToolTracking()) {
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
  onTestFinished(dispose);
  const start = (
    toolCallId: string,
    name: string,
    args: Record<string, unknown> = {},
    kind: Parameters<typeof handlers.emitParsedToolUseStart>[0]["kind"] = "mcp_tool_use",
  ) => handlers.emitParsedToolUseStart({ toolCallId, name, args, kind });
  const emitResult = (toolCallId: string, name: string, isError = false, result?: unknown) =>
    handlers.emitParsedToolResult({ toolCallId, name, isError, result });
  const data = (stream: string, phase?: string) =>
    events
      .filter((event) => event.stream === stream && (!phase || event.data.phase === phase))
      .map((event) => event.data);
  return { handlers, events, start, emitResult, data };
}

function captureCompletions(matcher: readonly [string, ...string[]] = ["exec", "web_fetch"]) {
  const observed: unknown[] = [];
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "after_tool_call",
        matcher,
        handler: (event) => observed.push(event),
      },
    ]),
  );
  return observed;
}

function startRecord(id: string, name: string, input: Record<string, unknown>) {
  return (
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    }) + "\n"
  );
}

function resultRecord(id: string, content: unknown, isError = false) {
  return (
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    }) + "\n"
  );
}

function displayParser(handlers: ReturnType<typeof createCliEventHandlers>) {
  return createCliJsonlStreamingParser({
    providerId: "claude-cli",
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    onAssistantDelta: vi.fn(),
    onToolUseStart: handlers.emitCliDisplayToolUseStart,
    onToolResult: handlers.emitCliDisplayToolResult,
  });
}

describe("cli tool result events", () => {
  it.each([
    "host",
    "host-blocks",
    "host-record",
    "node",
    "ambiguous",
    "late-ambiguous",
    "failed",
    "cli-error",
    "uncaptured",
    "no-details",
    "other-tool",
  ] as const)(
    "preserves only trusted, uniquely correlated browser routes in live results: %s",
    (mode) => {
      const context = buildContext(`browser-tab-${mode}`);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(context.params.runId, () => {});
      const { handlers, events } = eventFixture(context, tracking);
      const parser = createCliJsonlStreamingParser({
        providerId: "claude-cli",
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        onAssistantDelta: vi.fn(),
        onToolUseStart: handlers.emitParsedToolUseStart,
        onToolResult: handlers.emitParsedToolResult,
      });
      const toolName = mode === "other-tool" ? "web_fetch" : "browser";
      const name = `mcp__openclaw__${toolName}`;
      const args = { action: "open", profile: "shared", targetUrl: "https://example.org/" };
      const browserTab = {
        targetId: "tab-shared",
        profile: "shared",
        target: mode === "node" ? "node" : "host",
        ...(mode === "node" ? { node: "node-1" } : {}),
        url: "https://example.org/",
        title: "Shared tab",
      };
      const cliText = [{ type: "text", text: "CLI result" }];
      const cliResult =
        mode === "host-blocks"
          ? cliText
          : mode === "host-record"
            ? { content: cliText, details: { cli: "kept" } }
            : "CLI result";
      try {
        parser.push(startRecord("tab", name, args));
        if (mode === "ambiguous") {
          parser.push(startRecord("peer", name, args));
        }
        if (mode !== "uncaptured") {
          const capture = markMcpLoopbackToolCallStarted({
            captureKey: context.params.runId,
            toolName,
            args,
          });
          if (!capture) {
            throw new Error("Expected loopback capture");
          }
          recordMcpLoopbackToolCallResult({
            captureHandle: capture,
            toolName,
            args,
            outcome: mode === "failed" ? "failed" : "completed",
            result: {
              content: "Gateway result",
              details: { ...(mode === "no-details" ? {} : { browserTab }), unrelated: "omit" },
            },
          });
          markMcpLoopbackToolCallFinished(capture);
        }
        if (mode === "late-ambiguous") {
          parser.push(startRecord("peer", name, args));
        }
        parser.push(resultRecord("tab", cliResult, mode === "cli-error"));
        const toolEvents = events.filter(
          (event) => event.stream === "tool" && event.data.toolCallId === "tab",
        );
        expect.soft(toolEvents.map((event) => [event.data.phase, event.data.name])).toEqual([
          ["start", toolName],
          ["result", toolName],
        ]);
        // Scalar CLI text becomes a text block so the Control UI still shows it as output.
        expect(toolEvents[1]?.data.result).toEqual(
          mode === "host-record"
            ? { content: cliText, details: { cli: "kept", browserTab } }
            : mode === "host" || mode === "host-blocks" || mode === "node"
              ? { content: cliText, details: { browserTab } }
              : "CLI result",
        );
      } finally {
        tracking.finalizeCapture(() => {});
      }
    },
  );

  it.each([undefined, "side-question"] as const)(
    "keeps input progress separate from execution in %s mode",
    (executionMode) => {
      const context = buildContext(`input-${executionMode ?? "normal"}`);
      context.params.executionMode = executionMode;
      context.params.onExecutionPhase = vi.fn();
      const tracking = buildToolTracking();
      const { handlers, events } = eventFixture(context, tracking);
      handlers.emitCliToolInputDelta({
        toolCallId: "write",
        name: "write",
        inputChars: 42,
        diff: { added: 2, removed: 0 },
      });
      handlers.finalizeParsedTools();
      expect(context.params.onExecutionPhase).not.toHaveBeenCalled();
      expect(tracking.handleCliToolUseStart).not.toHaveBeenCalled();
      expect(handlers.hasObservedCliActivity()).toBe(true);
      expect(
        events.map(({ stream, data }) => [stream, data.phase, data.inputChars, data.diff]),
      ).toEqual(executionMode ? [] : [["tool", "input_delta", 42, { added: 2, removed: 0 }]]);
    },
  );

  it.each([
    ["poll", "kill", false, false],
    ["kill", "poll", true, false],
    ["kill", "poll", false, true],
  ] as const)(
    "preserves raw %s args after executing %s (quiet=%s, error=%s)",
    (requested, executed, quiet, isError) => {
      const context = buildContext(`rewrite-${requested}`);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(context.params.runId, () => {});
      const { events, start, emitResult, data } = eventFixture(context, tracking);
      const args = { action: requested, sessionId: "job" };
      onTestFinished(() => tracking.finalizeCapture(() => {}));
      start("call", "mcp__openclaw__process", args);
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
      emitResult("call", "mcp__openclaw__process", isError, "result");
      const terminal = events.find(
        (event) => event.stream === "item" && event.data.phase === "end",
      );
      expect(Boolean(terminal?.data.hideFromChannelProgress)).toBe(quiet);
      expect(data("tool", "result")[0]?.args).toEqual(args);
      expect(data("tool", "result")[0]?.isError).toBe(isError);
      emitResult("call", "mcp__openclaw__process", false, "duplicate terminal");
      expect(data("tool", "result")[1]?.args).toBeUndefined();
    },
  );

  it("projects parsed loopback waits with canonical names without duplicating display result args", () => {
    const runId = "parsed-activity";
    const { handlers, events } = eventFixture(buildContext(runId));
    const parser = displayParser(handlers);
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
      ["kill", "mcp__openclaw__process", { action: "kill", sessionId: "process-1" }, false, false],
      ["yield", "mcp__openclaw__sessions_yield", {}, false, true],
      ["third-party", "mcp__other__sessions_yield", {}, false, false],
    ] as const) {
      parser.push(startRecord(toolCallId, name, args));
      parser.push(resultRecord(toolCallId, "raw result", isError));
      const operation = events.filter((event) => event.data.toolCallId === toolCallId);
      expect(operation.map((event) => [event.stream, event.data.phase])).toEqual([
        ["item", "start"],
        ["tool", "start"],
        ["tool", "result"],
        ["item", "end"],
      ]);
      expect(operation[2]?.data).toMatchObject({
        name: name.replace(/^mcp__openclaw__/, ""),
        result: "raw result",
        isError,
      });
      expect(operation[2]?.data.args).toBeUndefined();
      expect(operation[2]?.data.hideFromChannelProgress).toBeUndefined();
      expect(Boolean(operation[3]?.data.hideFromChannelProgress)).toBe(quiet);
      expect(operation[3]?.data.name).toBe(name.replace(/^mcp__openclaw__/, ""));
    }
    handlers.emitParsedToolResult({
      toolCallId: "poll",
      name: "mcp__openclaw__process",
      isError: false,
      result: "duplicate terminal",
    });
    expect(events.findLast((event) => event.stream === "tool")?.data.args).toBeUndefined();
  });

  it.each([false, true])(
    "delivers display-only native failures to canonical matchers unless isolated (%s)",
    async (isolatedCompletion) => {
      const observed = captureCompletions();
      const context = buildContext(`native-completion-${isolatedCompletion}`);
      if (isolatedCompletion) {
        context.params.isolatedCompletion = true;
      }
      const { handlers } = eventFixture(context, createCliToolTracking(context));
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
        handlers.emitParsedToolResult({ toolCallId: name, name, isError: false });
      }
      handlers.emitParsedToolResult({ toolCallId: "unknown-call", name: "", isError: false });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await vi.waitFor(() =>
        expect(observed).toMatchObject(
          isolatedCompletion
            ? []
            : [
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
    const observed = captureCompletions(["exec"]);
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
});

describe("CLI progress-card plan projection", () => {
  it.each(["replacement", "clear", "ambiguous"] as const)(
    "projects only unambiguous executed progress-card arguments: %s",
    (mode) => {
      const runId = `executed-plan-${mode}`;
      const context = buildContext(runId);
      context.resultContentSourceByToolName = new Map([["progress_card", "network"]]);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(runId, () => {});
      const { events, start, emitResult } = eventFixture(context, tracking);
      const plan = { plan: [{ step: "Prepared checklist", status: "in_progress" }] };
      const requested = mode === "replacement" ? {} : plan;
      const executed = mode === "clear" ? {} : plan;
      const name = "mcp__openclaw__progress_card";
      onTestFinished(() => tracking.finalizeCapture(() => {}));
      start("card", name, requested);
      if (mode === "ambiguous") {
        start("peer", name, requested);
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
      emitResult("card", name);
      const result = events.find(
        (event) => event.stream === "tool" && event.data.phase === "result",
      );
      expect(result?.data.resultContentSource).toBe("network");
      const plans = events.filter((event) => event.stream === "plan");
      if (mode === "ambiguous") {
        expect(plans).toEqual([]);
      } else {
        expect(plans).toHaveLength(1);
        expect(plans[0]?.data.steps).toEqual(mode === "clear" ? [] : plan.plan);
      }
      expect(
        events.find((event) => event.stream === "tool" && event.data.phase === "result")?.data.args,
      ).toEqual(requested);
    },
  );

  it.each([
    ["progress_card", false],
    ["mcp__openclaw__progress_card", true],
  ] as const)(
    "keeps parsed display-only %s clears outside tracked plan state (tracked result first: %s)",
    (name, trackedResultFirst) => {
      const runId = `display-clear-${name}`;
      const tracking = buildToolTracking();
      const { handlers, events, start, emitResult } = eventFixture(buildContext(runId), tracking);
      const parser = displayParser(handlers);
      start("tracked-plan", name, { plan: [{ step: "Keep working", status: "in_progress" }] });
      emitResult("tracked-plan", name);
      parser.push(startRecord("display-clear", name, {}));
      if (trackedResultFirst) {
        emitResult("display-clear", name);
      }
      parser.push(resultRecord("display-clear", "done"));
      // Neither ordering may promote a display-only start into authoritative plan state.
      if (!trackedResultFirst) {
        emitResult("display-clear", name);
      }
      const plans = () => events.filter((event) => event.stream === "plan");
      expect(plans()).toHaveLength(1);
      expect(plans()[0]?.data.steps).toEqual([{ step: "Keep working", status: "in_progress" }]);
      start("tracked-clear", name, {});
      emitResult("tracked-clear", name);
      expect(plans()).toHaveLength(2);
      expect(plans()[1]?.data.steps).toEqual([]);
    },
  );

  it.each(["failed", "malformed", "other MCP server", "uncorrelated", "side question"])(
    "does not fabricate plan state for %s results",
    (mode) => {
      const name = mode === "other MCP server" ? "mcp__other__progress_card" : "progress_card";
      const args = {
        plan: mode === "malformed" ? "not a plan" : [{ step: "Inspect", status: "pending" }],
      };
      const runId = "no-plan";
      const context = buildContext(runId);
      if (mode === "side question") {
        context.params.executionMode = "side-question";
      }
      const { handlers, events } = eventFixture(context);
      const start = { toolCallId: "card", name, kind: "mcp_tool_use" as const, args };
      if (mode !== "uncorrelated") {
        handlers.emitParsedToolUseStart(start);
      }
      const result = { toolCallId: "card", name, isError: mode === "failed", result: "receipt" };
      handlers.emitParsedToolResult(result);
      expect(events.filter((event) => event.stream === "plan")).toEqual([]);
      if (mode === "side question") {
        expect(events).toEqual([]);
      }
    },
  );
});

describe("CLI plan channel bridge", () => {
  it.each([
    ["progress_card", false],
    ["mcp__openclaw__update_plan", false],
    ["mcp__openclaw__progress_card", true],
  ] as const)("bridges %s without completing the run (suppressed=%s)", async (name, suppressed) => {
    const runId = "plan-bridge";
    const updates: unknown[] = [];
    cliDispatchState.runCliAgentMock.mockImplementationOnce(
      async (params: PreparedCliRunContext["params"]) => {
        const { start, emitResult } = eventFixture({ ...buildContext(runId), params });
        const complete = (id: string, args: Record<string, unknown>) => {
          start(id, name, args);
          emitResult(id, name);
          emitResult(id, name);
        };
        complete("plan", { plan: [{ step: "Inspect\u200b", status: "completed" }] });
        complete("clear", {});
        complete("replacement", { plan: [{ step: "Replacement", status: "in_progress" }] });
        emitResult("clear", name);
        emitAgentEvent({ runId: "unrelated", stream: "plan", data: { steps: ["Ignore"] } });
        return { payloads: [{ text: "Final task answer" }], meta: { durationMs: 1 } };
      },
    );
    const result = await runCliAgentWithLifecycle({
      runId,
      onPlanUpdate: async (update) => {
        updates.push(update.steps);
      },
      suppressAssistantBridge: suppressed,
      runParams: buildContext(runId).params,
    });
    expect(updates).toEqual(
      suppressed
        ? []
        : [
            [{ step: "Inspect", status: "completed" }],
            [],
            [{ step: "Replacement", status: "in_progress" }],
          ],
    );
    expect(result.payloads).toEqual([{ text: "Final task answer" }]);
  });
});

describe("CLI prepared live output", () => {
  it("uses the current output replacements for commentary, streaming, and completion", () => {
    const context = buildContext("cli-live-output-policy");
    context.backendResolved.textTransforms = { output: [{ from: /MARKER/g, to: "first" }] };
    const { handlers, events } = eventFixture(context);
    handlers.emitCliCommentaryText("MARKER");
    context.backendResolved.textTransforms = { output: [{ from: /MARKER/g, to: "second" }] };
    handlers.emitCliAssistantDelta({ text: "MARKER", delta: "MARKER" });
    handlers.emitCliCompletedReply("MARKER", 0);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ progressText: "first" }),
      expect.objectContaining({ text: "second", delta: "second" }),
      expect.objectContaining({ completedText: "second" }),
    ]);
  });

  it("withholds possible controls before releasing the full leading-line suffix", () => {
    const token = "no_reply";
    const { handlers, events } = eventFixture(buildContext("cli-control-prefix"));
    handlers.emitCliAssistantDelta({ text: token.slice(0, 2), delta: token.slice(0, 2) });
    handlers.emitCliAssistantDelta({ text: token, delta: token.slice(2) });
    handlers.emitCliCompletedReply(token, 0);
    handlers.emitCliCommentaryText(` \t${token}\n`);
    expect(events).toEqual([]);
    handlers.emitCliAssistantDelta({
      text: `${token}\n  Answer.\n`,
      delta: `${token}\n  Answer.\n`,
    });
    expect(events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ text: "  Answer.\n", delta: "  Answer.\n" }),
      }),
    ]);
  });
});
