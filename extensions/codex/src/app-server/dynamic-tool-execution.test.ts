import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  resolveDynamicToolServerRequestTimeoutMs,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import { throwingResultObserver } from "./dynamic-tools.test-support.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

const dynamicCallContext = { threadId: "thread-1", turnId: "turn-1", namespace: null };
function toolCall(tool: string, args: CodexDynamicToolCallParams["arguments"] = {}) {
  return { ...dynamicCallContext, callId: "call-timeout", tool, arguments: args };
}
function textResponse(text: string, success = true): CodexDynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text }] };
}
const pendingTool = () => new Promise<never>(() => {});
const uncertainTerminal = () => ({
  executionStarted: true,
  sideEffectEvidence: true,
  effectReceipt: { state: "uncertain" as const },
});

function resolveTimeout(
  tool: string,
  args: CodexDynamicToolCallParams["arguments"],
  config?: EmbeddedRunAttemptParams["config"],
) {
  return resolveDynamicToolCallTimeoutMs({
    call: toolCall(tool, args),
    config,
  });
}

type MediaConfig = NonNullable<
  NonNullable<NonNullable<EmbeddedRunAttemptParams["config"]>["tools"]>["media"]
>;
const imageArgs = { prompt: "describe", paths: ["/tmp/one.jpg"] };
const messageArgs = { action: "send", message: "long outbound update" };
function imageModel(model: string, timeoutSeconds?: number) {
  return {
    provider: "openai",
    model,
    capabilities: ["image" as const],
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}
function viewTimeout(models: MediaConfig["models"], image: MediaConfig["image"]) {
  return resolveTimeout("view_image", imageArgs, { tools: { media: { models, image } } });
}

type ExecutionOptions = Parameters<typeof handleDynamicToolCallWithTimeout>[0];
function executeTool({
  signal = new AbortController().signal,
  timeoutMs = 1_000,
  ...options
}: Omit<ExecutionOptions, "signal" | "timeoutMs"> & {
  signal?: AbortSignal;
  timeoutMs?: number | null;
}) {
  return handleDynamicToolCallWithTimeout({
    ...options,
    signal,
    timeoutMs,
  });
}
async function expireTool(options: Parameters<typeof executeTool>[0]) {
  vi.useFakeTimers();
  const response = executeTool({ ...options, timeoutMs: 1 });
  await vi.advanceTimersByTimeAsync(1);
  return response;
}

function expectFailedCall(
  result: CodexDynamicToolRuntimeResponse,
  observer: ReturnType<typeof vi.fn>,
  toolName: string,
  message: string,
  status: string,
) {
  expect(toCodexDynamicToolProtocolResponse(result)).toEqual(textResponse(message, false));
  expect(observer).toHaveBeenCalledWith({
    toolName,
    result: { content: [{ type: "text", text: message }], details: { status, error: message } },
    isError: true,
  });
}

describe("dynamic tool execution helpers", () => {
  it("releases an ordinary successful tool operation before returning its result", async () => {
    const runController = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const remove = vi.spyOn(runController.signal, "removeEventListener");
    const response = await executeTool({
      call: toolCall("session_status"),
      toolBridge: {
        consumeToolExecutionSnapshot: () => undefined,
        handleToolCall: async (_call, options) => {
          operationSignal = options?.signal;
          return textResponse("done");
        },
      },
      signal: runController.signal,
    });
    expect(response.success).toBe(true);
    expect(operationSignal?.aborted).toBe(true);
    expect(String(operationSignal?.reason)).toContain("OpenClaw dynamic tool call finished.");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(runController.signal.aborted).toBe(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores non-positive timeoutSeconds", () => {
    expect(resolveTimeout("session_status", { timeoutSeconds: -1 })).toBe(90_000);
  });

  it("uses configured image generation timeouts for Codex dynamic tool calls", () => {
    const image = { primary: "openai/gpt-image-1", timeoutMs: 180_000 };
    const config = { agents: { defaults: { mediaModels: { image } } } };
    expect(resolveTimeout("image_generate", { prompt: "cat" }, config)).toBe(180_000);
    expect(viewTimeout([imageModel("vision")], { timeoutSeconds: 180 })).toBe(180_000);
    expect(
      viewTimeout([imageModel("inherited"), imageModel("short", 60)], {
        timeoutSeconds: 180,
      }),
    ).toBe(180_000);
  });

  it("uses default media and message dynamic tool deadlines", () => {
    const click = { action: "left_click", coordinate: [1, 1], timeoutMs: 1_000 };
    expect(resolveTimeout("computer", { action: "wait", duration: 100 })).toBe(220_000);
    expect(resolveTimeout("computer", click)).toBe(34_000);
    expect(resolveTimeout("image_generate", { prompt: "cat" })).toBe(120_000);
    expect(resolveTimeout("view_image", imageArgs)).toBe(60_000);
    expect(resolveTimeout("message", messageArgs)).toBe(600_000);
    expect(resolveTimeout("message", { ...messageArgs, timeoutMs: 30_000 })).toBe(600_000);
  });

  it("uses media image config and caps excessive dynamic tool timeouts", () => {
    const excessive = { prompt: "cat", timeoutMs: 601_000 };
    expect(
      viewTimeout([imageModel("short", 60), imageModel("long", 180)], {
        preferredModel: "openai/long",
      }),
    ).toBe(180_000);
    expect(resolveTimeout("image_generate", excessive)).toBe(600_000);
  });

  it("gives agents_wait the long-running cap while preserving its inner timeout budget", () => {
    expect(resolveTimeout("agents_wait", { ids: ["run-1"] })).toBe(630_000);
    expect(resolveTimeout("agents_wait", { ids: ["run-1"], timeoutSeconds: 120 })).toBe(150_000);
    const fullWaitTimeoutMs = resolveTimeout("agents_wait", {
      ids: ["run-1"],
      timeoutSeconds: 600,
    });
    expect(fullWaitTimeoutMs).toBe(630_000);
    expect(fullWaitTimeoutMs).toBeLessThan(660_000);
  });

  it("preserves the invalid fractional human question wait", () => {
    for (const tool of ["secrets", "ask_user"]) {
      expect(
        resolveTimeout(tool, {
          action: "request",
          name: "TEST_API_KEY",
          timeoutSeconds: 1.5,
        }),
      ).toBe(90_000);
    }
  });

  it("returns a failed dynamic tool response when an app-server tool call exceeds the deadline", async () => {
    let capturedSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const onFallbackSelected = vi.fn();
    const onAgentToolResult = vi.fn();
    const response = expireTool({
      call: toolCall("message", { action: "send", text: "hello" }),
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          capturedSignal = options?.signal;
          return pendingTool();
        }),
      },
      onAgentToolResult,
      observeToolTerminal: uncertainTerminal,
      onFallbackSelected,
      onTimeout,
    });
    expectFailedCall(
      await response,
      onAgentToolResult,
      "message",
      "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
      "timed_out",
    );
    expect(await response).toMatchObject({
      diagnosticTerminalReason: "timed_out",
      executionStarted: true,
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(onFallbackSelected).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("enforces the resolved openclaw cap at 930000 ms", async () => {
    const deadlineMs = 930_000;
    vi.useFakeTimers();
    const call = toolCall("openclaw", { timeoutSeconds: 1_000 });
    expect(resolveDynamicToolServerRequestTimeoutMs(call)).toBeGreaterThan(deadlineMs);
    const onTimeout = vi.fn();
    const response = executeTool({
      call,
      toolBridge: { handleToolCall: vi.fn(pendingTool) },
      timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined }),
      onTimeout,
    });
    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(response).resolves.toMatchObject({
      success: false,
      diagnosticTerminalReason: "timed_out",
    });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delegates an unpublished abort boundary to the terminal observer", async () => {
    const observeToolTerminal = vi.fn(
      (
        _observation: Parameters<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>[0],
      ) => ({
        executionStarted: false,
        executedArguments: {
          action: "send",
          target: "channel:adjusted",
          text: "hello",
        },
        sideEffectEvidence: false,
        effectReceipt: { state: "uncertain" as const },
      }),
    );
    const response = expireTool({
      call: toolCall("message", { action: "send", target: "channel:original", text: "hello" }),
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          expect(options?.retainExecutionSnapshot).toBe(true);
          return new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                const reason = options.signal?.reason;
                reject(reason instanceof Error ? reason : new Error("tool call aborted"));
              },
              { once: true },
            );
          });
        }),
        consumeToolExecutionSnapshot: vi.fn(() => undefined),
      },
      observeToolTerminal,
    });
    await expect(response).resolves.toMatchObject({
      executionStarted: false,
      success: false,
      executedArguments: { action: "send", target: "channel:adjusted", text: "hello" },
    });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { action: "send", target: "channel:original", text: "hello" },
        outcome: "failure",
      }),
    );
    expect(observeToolTerminal.mock.calls[0]?.[0]).not.toHaveProperty("executionStarted");
  });

  it("reports pre-execution cancellations to the private result observer", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    const onAgentToolResult = vi.fn();
    const handleToolCall = vi.fn();
    const result = await executeTool({
      call: toolCall("memory_search"),
      toolBridge: { handleToolCall },
      signal: controller.signal,
      onAgentToolResult,
    });
    expectFailedCall(
      result,
      onAgentToolResult,
      "memory_search",
      "OpenClaw dynamic tool call aborted before execution.",
      "cancelled",
    );
    expect(result).toMatchObject({
      diagnosticTerminalReason: "cancelled",
      executionStarted: false,
    });
    expect(handleToolCall).not.toHaveBeenCalled();
    expect(onAgentToolResult).toHaveBeenCalledOnce();
  });

  it("preserves enclosing timeout provenance for pre-execution aborts", async () => {
    const controller = new AbortController();
    controller.abort("turn_completion_idle_timeout");
    const result = await executeTool({
      call: toolCall("memory_search"),
      toolBridge: { handleToolCall: vi.fn() },
      signal: controller.signal,
    });
    expect(result.diagnosticTerminalReason).toBe("timed_out");
  });

  it("preserves enclosing timeout provenance for active aborts", async () => {
    const controller = new AbortController();
    const resultPromise = executeTool({
      call: toolCall("memory_search"),
      toolBridge: { handleToolCall: vi.fn(pendingTool) },
      signal: controller.signal,
    });
    controller.abort(Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }));
    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      diagnosticTerminalReason: "timed_out",
    });
  });

  it("preserves a successful bridge result when its observer throws an unreadable error", async () => {
    const { onAgentToolResult, warn } = throwingResultObserver();
    const successful = {
      ...textResponse("committed effect"),
      executionStarted: true,
      sideEffectEvidence: true,
    };
    const result = await executeTool({
      call: toolCall("exec"),
      toolBridge: {
        handleToolCall: async (_call, options) => {
          options?.onAgentToolResult?.({
            toolName: "exec",
            result: { content: [{ type: "text", text: "committed effect" }], details: {} },
            isError: false,
          });
          return successful;
        },
      },
      timeoutMs: 1000,
      onAgentToolResult,
    });
    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(result).toBe(successful);
    expect(result.diagnosticTerminalReason).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "onAgentToolResult handler failed: tool=exec error=Error",
    );
  });

  it("keeps async-start metadata on internal dynamic tool progress only", () => {
    const mcpAppPreview = { resourceUri: "ui://fixture/preview", title: "Preview" };
    const response: CodexDynamicToolRuntimeResponse = {
      contentItems: [{ type: "inputText", text: "Background task started." }],
      success: true,
      asyncStarted: true,
      executedArguments: { action: "send", to: "channel:123" },
      executionStarted: true,
      replaySafe: false,
      sideEffectEvidence: true,
      terminate: true,
      diagnosticTerminalType: "completed",
      transcriptDetails: { mcpAppPreview, privateModelPayload: "host only" },
    };
    const protocolResponse = toCodexDynamicToolProtocolResponse(response);
    const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);
    expect(protocolResponse).toEqual(textResponse("Background task started."));
    expect(progressResponse).toEqual({
      ...textResponse("Background task started."),
      details: { mcpAppPreview, async: true, status: "started" },
    });
  });

  it("preserves foreground node execution with timeoutSeconds=900", async () => {
    const completionMs = 690_000;
    vi.useFakeTimers();
    const call = toolCall("node_exec", { command: "long-command", timeoutSeconds: 900 });
    const getExecutionTimeoutMs = vi.fn(() => 910_000);
    const completed = textResponse("command completed");
    const toolBridge = {
      availableTools: [
        {
          name: "node_exec",
          label: "node_exec",
          description: "Run a command on the node",
          parameters: {},
          execute: vi.fn(),
          getExecutionTimeoutMs,
        },
      ],
      handleToolCall: () =>
        new Promise<CodexDynamicToolCallResponse>((resolve) => {
          setTimeout(() => resolve(completed), completionMs);
        }),
    };
    const response = executeTool({
      call,
      toolBridge,
      timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined, toolBridge }),
    });
    await vi.advanceTimersByTimeAsync(completionMs);
    await expect(response).resolves.toEqual(completed);
    expect(getExecutionTimeoutMs).toHaveBeenCalledExactlyOnceWith(call.arguments);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the concrete tool owner when timeout wins before a snapshot", async () => {
    const ownerKey = '["memory-lancedb","memory_store"]';
    const observeToolTerminal = vi.fn(uncertainTerminal);
    const response = expireTool({
      call: toolCall("memory_store", { text: "Tuesday 09:00 release window" }),
      toolBridge: {
        handleToolCall: vi.fn(pendingTool),
        consumeToolExecutionSnapshot: vi.fn(() => undefined),
        sideEffectOwnerKeyForTool: vi.fn(() => ownerKey),
      },
      observeToolTerminal,
    });
    await expect(response).resolves.toMatchObject({ success: false });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerMutation: { ownerKey },
        outcome: "failure",
      }),
    );
  });

  it("preserves partial search timeout details in terminal resolution", async () => {
    const details = {
      results: [{ path: "memory/first.md" }, { path: "memory/second.md" }],
      partial: true,
      timedOut: true,
      timeoutMs: 30_000,
      error: "memory_search timed out after 30s",
    };
    const bridgeResponse = {
      success: false,
      contentItems: [{ type: "inputText" as const, text: JSON.stringify(details) }],
      transcriptDetails: details,
    };
    const response = await executeTool({
      call: toolCall("memory_search", { query: "coding session categories" }),
      toolBridge: { handleToolCall: vi.fn(async () => bridgeResponse) },
      timeoutMs: 90_000,
      observeToolTerminal: createContractToolTerminalObserver("run-partial-memory-timeout"),
    });
    expect(response.terminalResolution?.lastToolError?.terminalDiagnostic).toEqual({
      kind: "timeout",
      timeoutMs: 30_000,
      partialResults: 2,
    });
    expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
      contentItems: bridgeResponse.contentItems,
      success: false,
    });
  });

  it("logs process poll timeout context separately from session idle", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const response = expireTool({
      call: toolCall("process", { action: "poll", sessionId: "process-session", timeout: 30_000 }),
      toolBridge: { handleToolCall: vi.fn(pendingTool) },
      observeToolTerminal: () => ({
        ...uncertainTerminal(),
        executedArguments: { action: "poll", sessionId: "adjusted-session" },
      }),
    });
    expect(toCodexDynamicToolProtocolResponse(await response)).toEqual(
      textResponse(
        "OpenClaw dynamic tool call timed out after 1ms while waiting for process action=poll sessionId=process-session. This is a tool RPC timeout, not a session idle timeout.",
        false,
      ),
    );
    await expect(response).resolves.toMatchObject({
      executionStarted: true,
      executedArguments: { action: "poll", sessionId: "adjusted-session" },
    });
    expect(warn).toHaveBeenCalledWith("codex dynamic tool call timed out", {
      tool: "process",
      toolCallId: "call-timeout",
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1,
      timeoutKind: "codex_dynamic_tool_rpc",
      processAction: "poll",
      processSessionId: "process-session",
      processRequestedTimeoutMs: 30_000,
      consoleMessage:
        "codex process tool timeout: action=poll sessionId=process-session toolTimeoutMs=1 requestedWaitMs=30000; per-tool-call watchdog, not session idle; repeated lines usually mean process-poll retry churn, not model progress",
    });
  });

  it("does not split surrogate pairs when truncating timeout log fields", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const action = `${"a".repeat(156)}😀tail`;
    const sessionId = `${"s".repeat(156)}😀tail`;
    const response = expireTool({
      call: toolCall("process", { action, sessionId, timeout: 30_000 }),
      toolBridge: { handleToolCall: vi.fn(pendingTool) },
    });
    const result = await response;
    const firstResultItem = result.contentItems[0];
    const resultText = firstResultItem?.type === "inputText" ? firstResultItem.text : "";
    const [, details] = warn.mock.calls[0] ?? [];
    const highSurrogate = String.fromCharCode(0xd83d);
    expect(result).toMatchObject({
      success: false,
      executionStarted: true,
      sideEffectEvidence: true,
    });
    expect(details).toMatchObject({
      processAction: `${"a".repeat(156)}...`,
      processSessionId: `${"s".repeat(156)}...`,
    });
    expect(resultText).not.toContain(highSurrogate);
    expect(String((details as Record<string, unknown>).consoleMessage)).not.toContain(
      highSurrogate,
    );
  });
});
