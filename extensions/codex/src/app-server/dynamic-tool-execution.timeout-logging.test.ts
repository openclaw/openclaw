import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";

describe("dynamic tool timeout diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
