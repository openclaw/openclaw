// Codex tests cover dynamic tool execution plugin behavior.
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  resolveDynamicToolServerRequestTimeoutMs,
  resolveTerminalDynamicToolBatchAction,
  shouldReleaseTurnAfterTerminalDynamicTool,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

const dynamicCallContext = { threadId: "thread-1", turnId: "turn-1", namespace: null };

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS;
const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

function resolveTimeout(
  tool: string,
  args: CodexDynamicToolCallParams["arguments"],
  config?: EmbeddedRunAttemptParams["config"],
) {
  return resolveDynamicToolCallTimeoutMs({
    call: { ...dynamicCallContext, callId: "call-timeout", tool, arguments: args },
    config,
  });
}

describe("dynamic tool execution helpers", () => {
  it("releases an ordinary successful tool operation before returning its result", async () => {
    const runController = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const remove = vi.spyOn(runController.signal, "removeEventListener");
    const response = await handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "ordinary-cleanup",
        tool: "session_status",
        arguments: {},
      },
      toolBridge: {
        consumeToolExecutionSnapshot: () => undefined,
        handleToolCall: async (_call, options) => {
          operationSignal = options?.signal;
          return { success: true, contentItems: [{ type: "inputText", text: "done" }] };
        },
      },
      signal: runController.signal,
      timeoutMs: 1_000,
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
    expect(resolveTimeout("session_status", { timeoutSeconds: -1 })).toBe(
      CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
    );
  });

  it("uses configured image generation timeouts for Codex dynamic tool calls", () => {
    expect(
      resolveTimeout(
        "image_generate",
        { prompt: "cat" },
        {
          agents: {
            defaults: {
              mediaModels: {
                image: {
                  primary: "openai/gpt-image-1",
                  timeoutMs: 180_000,
                },
              },
            },
          },
        },
      ),
    ).toBe(180_000);
    expect(
      resolveTimeout(
        "view_image",
        { prompt: "describe", paths: ["/tmp/one.jpg"] },
        {
          tools: {
            media: {
              models: [{ provider: "openai", model: "vision", capabilities: ["image"] }],
              image: { timeoutSeconds: 180 },
            },
          },
        },
      ),
    ).toBe(180_000);
    expect(
      resolveTimeout(
        "view_image",
        { prompt: "describe", paths: ["/tmp/one.jpg"] },
        {
          tools: {
            media: {
              models: [
                { provider: "openai", model: "inherited", capabilities: ["image"] },
                {
                  provider: "openai",
                  model: "short",
                  capabilities: ["image"],
                  timeoutSeconds: 60,
                },
              ],
              image: { timeoutSeconds: 180 },
            },
          },
        },
      ),
    ).toBe(180_000);
  });

  it("uses default media and message dynamic tool deadlines", () => {
    expect(resolveTimeout("computer", { action: "wait", duration: 100 })).toBe(220_000);
    expect(
      resolveTimeout("computer", { action: "left_click", coordinate: [1, 1], timeoutMs: 1_000 }),
    ).toBe(34_000);
    expect(resolveTimeout("image_generate", { prompt: "cat" })).toBe(120_000);
    expect(resolveTimeout("view_image", { prompt: "describe", paths: ["/tmp/one.jpg"] })).toBe(
      CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
    );
    expect(resolveTimeout("message", { action: "send", message: "long outbound update" })).toBe(
      CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS,
    );
    expect(
      resolveTimeout("message", {
        action: "send",
        message: "long outbound update",
        timeoutMs: 30_000,
      }),
    ).toBe(CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS);
  });

  it("uses media image config and caps excessive dynamic tool timeouts", () => {
    expect(
      resolveTimeout(
        "view_image",
        { prompt: "describe", paths: ["/tmp/one.jpg"] },
        {
          tools: {
            media: {
              models: [
                { provider: "openai", model: "short", timeoutSeconds: 60, capabilities: ["image"] },
                { provider: "openai", model: "long", timeoutSeconds: 180, capabilities: ["image"] },
              ],
              image: { preferredModel: "openai/long" },
            },
          },
        },
      ),
    ).toBe(180_000);
    expect(
      resolveTimeout("image_generate", {
        prompt: "cat",
        timeoutMs: CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + 1_000,
      }),
    ).toBe(CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS);
  });

  it("gives agents_wait the long-running cap while preserving its inner timeout budget", () => {
    const call = {
      ...dynamicCallContext,
      callId: "call-agents-wait",
      tool: "agents_wait",
    };

    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"] } },
        config: undefined,
      }),
    ).toBe(630_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 120 } },
        config: undefined,
      }),
    ).toBe(150_000);
    const fullWaitTimeoutMs = resolveDynamicToolCallTimeoutMs({
      call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 600 } },
      config: undefined,
    });
    expect(fullWaitTimeoutMs).toBe(630_000);
    expect(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThan(fullWaitTimeoutMs);
  });

  it.each([{ name: "invalid fractional", timeoutSeconds: 1.5, expectedMs: 90_000 }])(
    "preserves the $name human question wait",
    ({ timeoutSeconds, expectedMs }) => {
      for (const tool of ["secrets", "ask_user"]) {
        expect(
          resolveTimeout(tool, {
            action: "request",
            name: "TEST_API_KEY",
            ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
          }),
        ).toBe(expectedMs);
      }
    },
  );

  it("returns a failed dynamic tool response when an app-server tool call exceeds the deadline", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const onFallbackSelected = vi.fn();
    const onAgentToolResult = vi.fn();
    const response = handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "call-timeout",
        tool: "message",
        arguments: { action: "send", text: "hello" },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          capturedSignal = options?.signal;
          return new Promise<never>(() => {});
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      onAgentToolResult,
      observeToolTerminal: () => ({
        executionStarted: true,
        sideEffectEvidence: true,
        effectReceipt: { state: "uncertain" as const },
      }),
      onFallbackSelected,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(toCodexDynamicToolProtocolResponse(await response)).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
        },
      ],
    });
    expect((await response).diagnosticTerminalReason).toBe("timed_out");
    expect((await response).executionStarted).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    expect(onFallbackSelected).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "message",
      result: {
        content: [
          {
            type: "text",
            text: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
          },
        ],
        details: {
          status: "timed_out",
          error: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
        },
      },
      isError: true,
    });
  });

  it.each([{ tool: "openclaw", deadlineMs: 930_000 }])(
    "enforces the resolved $tool cap at $deadlineMs ms",
    async ({ tool, deadlineMs }) => {
      vi.useFakeTimers();
      const call = {
        ...dynamicCallContext,
        callId: "call-capped-timeout",
        tool,
        arguments: { timeoutSeconds: 1_000 },
      };
      expect(resolveDynamicToolServerRequestTimeoutMs(call)).toBeGreaterThan(deadlineMs);
      const onTimeout = vi.fn();
      const response = handleDynamicToolCallWithTimeout({
        call,
        toolBridge: { handleToolCall: vi.fn(() => new Promise<never>(() => {})) },
        signal: new AbortController().signal,
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
    },
  );

  it("delegates an unpublished abort boundary to the terminal observer", async () => {
    vi.useFakeTimers();
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
    const response = handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "call-abort-aware-timeout",
        tool: "message",
        arguments: { action: "send", target: "channel:original", text: "hello" },
      },
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
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ executionStarted: false, success: false });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { action: "send", target: "channel:original", text: "hello" },
        outcome: "failure",
      }),
    );
    expect(observeToolTerminal.mock.calls[0]?.[0]).not.toHaveProperty("executionStarted");
    await expect(response).resolves.toMatchObject({
      executedArguments: {
        action: "send",
        target: "channel:adjusted",
        text: "hello",
      },
    });
  });

  it("reports pre-execution cancellations to the private result observer", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    const onAgentToolResult = vi.fn();
    const handleToolCall = vi.fn();

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "call-aborted",
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall },
      signal: controller.signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: false,
      contentItems: [
        { type: "inputText", text: "OpenClaw dynamic tool call aborted before execution." },
      ],
    });
    expect(result.diagnosticTerminalReason).toBe("cancelled");
    expect(result.executionStarted).toBe(false);
    expect(handleToolCall).not.toHaveBeenCalled();
    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_search",
      result: {
        content: [{ type: "text", text: "OpenClaw dynamic tool call aborted before execution." }],
        details: {
          status: "cancelled",
          error: "OpenClaw dynamic tool call aborted before execution.",
        },
      },
      isError: true,
    });
  });

  it.each(["turn_completion_idle_timeout"])(
    "preserves enclosing timeout provenance for pre-execution aborts",
    async (reason) => {
      const controller = new AbortController();
      controller.abort(reason);

      const result = await handleDynamicToolCallWithTimeout({
        call: {
          ...dynamicCallContext,
          callId: "call-timeout-abort",
          tool: "memory_search",
          arguments: {},
        },
        toolBridge: { handleToolCall: vi.fn() },
        signal: controller.signal,
        timeoutMs: 1_000,
      });

      expect(result.diagnosticTerminalReason).toBe("timed_out");
    },
  );

  it("classifies app-server client closure as a failed tool outcome", async () => {
    const controller = new AbortController();
    controller.abort("client_closed");

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "call-client-closed",
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn() },
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(result.diagnosticTerminalReason).toBe("failed");
  });

  it("preserves enclosing timeout provenance for active aborts", async () => {
    const controller = new AbortController();
    const resultPromise = handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "call-active-timeout-abort",
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn(() => new Promise<never>(() => {})) },
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort(Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }));

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      diagnosticTerminalReason: "timed_out",
    });
  });

  it("preserves a successful bridge result when its observer throws an unreadable error", async () => {
    const observerError = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("observer message getter escaped");
      },
    });
    const onAgentToolResult = vi.fn(() => {
      throw observerError;
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    warn.mockClear();
    const successful = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "committed effect" }],
      executionStarted: true,
      sideEffectEvidence: true,
    };
    const completedAction = vi.fn(async () => successful);
    const result = await handleDynamicToolCallWithTimeout({
      call: { ...dynamicCallContext, callId: "observer-success", tool: "exec", arguments: {} },
      toolBridge: {
        handleToolCall: async (_call, options) => {
          const response = await completedAction();
          options?.onAgentToolResult?.({
            toolName: "exec",
            result: { content: [{ type: "text", text: "committed effect" }], details: {} },
            isError: false,
          });
          return response;
        },
      },
      signal: new AbortController().signal,
      timeoutMs: 1000,
      onAgentToolResult,
    });
    expect(completedAction).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(result).toBe(successful);
    expect(result.success).toBe(true);
    expect(result.sideEffectEvidence).toBe(true);
    expect(result.diagnosticTerminalReason).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "onAgentToolResult handler failed: tool=exec error=Error",
    );
  });

  it("contains hostile abort reasons while notifying the private observer", async () => {
    const hostileReason = Object.defineProperty({}, "name", {
      get() {
        throw new Error("name getter escaped");
      },
    });
    const controller = new AbortController();
    controller.abort(hostileReason);
    const onAgentToolResult = vi.fn();

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        ...dynamicCallContext,
        callId: "call-hostile-abort",
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn() },
      signal: controller.signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(result).toMatchObject({
      success: false,
      diagnosticTerminalReason: "cancelled",
    });
    expect(onAgentToolResult).toHaveBeenCalledOnce();
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

    expect(protocolResponse).toEqual({
      contentItems: [{ type: "inputText", text: "Background task started." }],
      success: true,
    });
    expect(progressResponse).toEqual({
      contentItems: [{ type: "inputText", text: "Background task started." }],
      details: { mcpAppPreview, async: true, status: "started" },
      success: true,
    });
  });

  it("allows turn release after successful terminal dynamic tool responses", () => {
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: false,
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: true,
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: false,
        activeAppServerTurnRequests: 1,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: false,
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 1,
      }),
    ).toBe(false);
  });

  it("resolves terminal dynamic tool batch state", () => {
    expect(
      resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: 1,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
        currentTurnHadNonTerminalDynamicToolResult: false,
        hasPendingTerminalDynamicToolRelease: true,
      }),
    ).toBe("wait");
    expect(
      resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
        currentTurnHadNonTerminalDynamicToolResult: true,
        hasPendingTerminalDynamicToolRelease: true,
      }),
    ).toBe("clear-nonterminal-batch");
    expect(
      resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
        currentTurnHadNonTerminalDynamicToolResult: false,
        hasPendingTerminalDynamicToolRelease: true,
      }),
    ).toBe("release-pending-terminal");
  });

  it.each([{ timeoutSeconds: 900, executionTimeoutMs: 910_000, completionMs: 690_000 }])(
    "preserves foreground node execution with timeoutSeconds=$timeoutSeconds",
    async ({ timeoutSeconds, executionTimeoutMs, completionMs }) => {
      vi.useFakeTimers();
      const call = {
        ...dynamicCallContext,
        callId: "call-node-exec",
        tool: "node_exec",
        arguments: {
          command: "long-command",
          timeoutSeconds,
        },
      };
      const getExecutionTimeoutMs = vi.fn(() => executionTimeoutMs);
      const completed: CodexDynamicToolCallResponse = {
        success: true,
        contentItems: [{ type: "inputText", text: "command completed" }],
      };
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
      const response = handleDynamicToolCallWithTimeout({
        call,
        toolBridge,
        signal: new AbortController().signal,
        timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined, toolBridge }),
      });

      await vi.advanceTimersByTimeAsync(completionMs);

      await expect(response).resolves.toEqual(completed);
      expect(getExecutionTimeoutMs).toHaveBeenCalledExactlyOnceWith(call.arguments);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains the concrete tool owner when timeout wins before a snapshot", async () => {
    vi.useFakeTimers();
    const ownerKey = '["memory-lancedb","memory_store"]';
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
      effectReceipt: { state: "uncertain" as const },
    }));
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-owner-timeout",
        namespace: null,
        tool: "memory_store",
        arguments: { text: "Tuesday 09:00 release window" },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
        consumeToolExecutionSnapshot: vi.fn(() => undefined),
        sideEffectOwnerKeyForTool: vi.fn(() => ownerKey),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ success: false });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerMutation: { ownerKey },
        outcome: "failure",
      }),
    );
  });

  it("preserves partial search timeout details through terminal reply generation", async () => {
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
    const response = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        namespace: null,
        callId: "call-partial-memory-timeout",
        tool: "memory_search",
        arguments: { query: "coding session categories" },
      },
      toolBridge: { handleToolCall: vi.fn(async () => bridgeResponse) },
      signal: new AbortController().signal,
      timeoutMs: 90_000,
      observeToolTerminal: createContractToolTerminalObserver("run-partial-memory-timeout"),
    });

    expect(
      buildContractReplyPayloads({
        assistantText: "",
        lastToolError: response.terminalResolution?.lastToolError,
      }),
    ).toEqual([
      expect.objectContaining({
        text: "⚠️ Memory Search timed out after 30s; 2 partial results are available.",
      }),
    ]);
    expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
      contentItems: bridgeResponse.contentItems,
      success: false,
    });
  });

  it("logs process poll timeout context separately from session idle", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout",
        namespace: null,
        tool: "process",
        arguments: { action: "poll", sessionId: "process-session", timeout: 30_000 },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal: () => ({
        executionStarted: true,
        executedArguments: { action: "poll", sessionId: "adjusted-session" },
        sideEffectEvidence: true,
        effectReceipt: { state: "uncertain" },
      }),
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(toCodexDynamicToolProtocolResponse(await response)).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw dynamic tool call timed out after 1ms while waiting for process action=poll sessionId=process-session. This is a tool RPC timeout, not a session idle timeout.",
        },
      ],
    });
    await expect(response).resolves.toMatchObject({ executionStarted: true });
    await expect(response).resolves.toMatchObject({
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
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const action = `${"a".repeat(156)}😀tail`;
    const sessionId = `${"s".repeat(156)}😀tail`;
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-utf16-log-field",
        namespace: null,
        tool: "process",
        arguments: { action, sessionId, timeout: 30_000 },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);

    const result = await response;
    const firstResultItem = result.contentItems[0];
    const resultText = firstResultItem?.type === "inputText" ? firstResultItem.text : "";
    const [, details] = warn.mock.calls[0] ?? [];
    const highSurrogate = String.fromCharCode(0xd83d);

    expect(result.success).toBe(false);
    expect(result.executionStarted).toBe(true);
    expect(result.sideEffectEvidence).toBe(true);
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
