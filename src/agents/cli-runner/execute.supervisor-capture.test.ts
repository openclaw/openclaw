// Covers CLI execution paths where the process supervisor keeps stdout capture
// disabled and the runner must parse streamed chunks without relying on tails.
import { beforeEach, describe, expect, it } from "vitest";
import {
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult as recordMcpLoopbackToolCallResultForHandle,
  resolveMcpLoopbackYieldContext,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { createManagedRun, supervisorSpawnMock } from "../cli-runner.test-support.js";
import { getCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import { executePreparedCliRun } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnInput = Parameters<ProcessSupervisor["spawn"]>[0];

function recordMcpLoopbackToolCallResult(params: {
  captureKey: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
}): void {
  const captureHandle = markMcpLoopbackToolCallStarted(params);
  if (!captureHandle) {
    return;
  }
  recordMcpLoopbackToolCallResultForHandle({
    captureHandle,
    toolName: params.toolName,
    args: params.args,
    result: params.result,
    isError: params.isError,
  });
  markMcpLoopbackToolCallFinished(captureHandle);
}

function buildPreparedCliRunContext(params: {
  output: "jsonl" | "text";
  provider?: string;
}): PreparedCliRunContext {
  const provider = params.provider ?? "codex-cli";
  const backend = {
    command: "agent-cli",
    args: [],
    output: params.output,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider,
      model: "model",
      timeoutMs: 1_000,
      runId: `run-${params.output}`,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: false,
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {},
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function requireSupervisorSpawnInput(): SupervisorSpawnInput {
  const call = supervisorSpawnMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected supervisor spawn");
  }
  return call[0] as SupervisorSpawnInput;
}

beforeEach(() => {
  resetAgentEventsForTest();
  supervisorSpawnMock.mockReset();
});

describe("executePreparedCliRun supervisor output capture", () => {
  it("disables supervisor capture without parsing from the diagnostic stdout tail", async () => {
    const fullText = `start-${"x".repeat(80 * 1024)}-end`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(fullText);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : fullText,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(buildPreparedCliRunContext({ output: "text" }));
    const spawnInput = requireSupervisorSpawnInput();

    expect(spawnInput.captureOutput).toBe(false);
    expect(result.rawText).toBe(fullText);
  });

  it("rejects oversized successful stdout instead of parsing a truncated tail", async () => {
    const noisyPrefix = "x".repeat(2 * 1024 * 1024);
    const finalText = "final answer";

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(noisyPrefix);
      input.onStdout?.(finalText);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${noisyPrefix}${finalText}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await expect(
      executePreparedCliRun(buildPreparedCliRunContext({ output: "text" })),
    ).rejects.toThrow("CLI stdout exceeded");
    const spawnInput = requireSupervisorSpawnInput();

    expect(spawnInput.captureOutput).toBe(false);
  });

  it("parses valid oversized JSONL output incrementally", async () => {
    // JSONL agents can emit huge tool deltas; only the incremental parser sees
    // the complete stream once supervisor capture is intentionally off.
    const largeToolEvent = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
      },
    })}\n`;
    const resultEvent = `${JSON.stringify({
      type: "result",
      session_id: "session-jsonl-large",
      result: "final answer",
    })}\n`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(largeToolEvent);
      input.onStdout?.(resultEvent);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${largeToolEvent}${resultEvent}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.text).toBe("final answer");
    expect(result.sessionId).toBe("session-jsonl-large");
  });

  it("parses oversized resume JSONL output from the effective resume output mode", async () => {
    const largeToolEvent = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
      },
    })}\n`;
    const resultEvent = `${JSON.stringify({
      type: "result",
      session_id: "resume-jsonl-session",
      result: "resumed answer",
    })}\n`;
    const context = buildPreparedCliRunContext({
      output: "text",
      provider: "resume-jsonl-cli",
    });
    // Resume can switch the backend from text to JSONL, so the executor must
    // derive parser mode from the effective resume config instead of the base.
    Object.assign(context.preparedBackend.backend, {
      jsonlDialect: "claude-stream-json" as const,
      resumeArgs: ["resume", "{sessionId}"],
      resumeOutput: "jsonl" as const,
      sessionMode: "existing" as const,
    });

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(largeToolEvent);
      input.onStdout?.(resultEvent);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${largeToolEvent}${resultEvent}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context, "resume-jsonl-session");

    expect(result.text).toBe("resumed answer");
    expect(result.sessionId).toBe("resume-jsonl-session");
  });

  it("classifies failed stdout from the retained parse buffer before the diagnostic tail", async () => {
    // The error classifier needs the retained parse buffer; the human-facing
    // diagnostic tail may contain only noise once stdout grows large.
    const errorPrefix = `${JSON.stringify({
      type: "result",
      is_error: true,
      result: "429 rate limit exceeded",
    })}\n`;
    const noisyTail = "x".repeat(80 * 1024);

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(errorPrefix);
      input.onStdout?.(noisyTail);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${errorPrefix}${noisyTail}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(buildPreparedCliRunContext({ output: "text" }));
    } catch (error) {
      const classified = error as { reason?: unknown; status?: unknown };
      expect(classified.reason).toBe("rate_limit");
      expect(classified.status).toBe(429);
      return;
    }
    throw new Error("Expected CLI run to reject with a rate limit error");
  });

  it("still streams every JSONL stdout chunk with supervisor capture disabled", async () => {
    // Streaming events are emitted from live chunks, not from the final captured
    // stdout string, so users still see deltas when captureOutput is false.
    const agentEvents: Array<{ text?: string; delta?: string }> = [];
    const stop = onAgentEvent((event) => {
      if (event.stream !== "assistant") {
        return;
      }
      agentEvents.push({
        text: typeof event.data.text === "string" ? event.data.text : undefined,
        delta: typeof event.data.delta === "string" ? event.data.delta : undefined,
      });
    });
    const chunks = [
      `${JSON.stringify({ type: "init", session_id: "session-jsonl" })}\n`,
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      })}\n`,
      `not-json ${"x".repeat(80 * 1024)}\n`,
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      })}\n`,
      `${JSON.stringify({
        type: "result",
        session_id: "session-jsonl",
        result: "Hello world",
      })}\n`,
    ];

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : chunks.join(""),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
      const spawnInput = requireSupervisorSpawnInput();

      expect(spawnInput.captureOutput).toBe(false);
      expect(result.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });

  it("reports only confirmed message deliveries from correlated JSONL tool events", async () => {
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "message-send-1",
              name: "mcp__openclaw__message",
              input: {
                action: "send",
                channel: "telegram",
                target: "chat123",
                message: "done",
              },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "message-send-1",
              content: [{ type: "text", text: JSON.stringify({ result: { messageId: "msg-1" } }) }],
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { ok: true, to: "spaces/AAA" },
        isError: false,
      });
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;
    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
      }),
    ]);
  });

  it("captures message text aliases from correlated JSONL tool events", async () => {
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "message-send-text-alias",
              name: "mcp__openclaw__message",
              input: {
                action: "send",
                channel: "telegram",
                target: "chat123",
                text: "done",
              },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "message-send-text-alias",
              content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.messagingToolSentTexts).toEqual(["done"]);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
      }),
    ]);
  });

  it("bounds pending and committed JSONL message delivery evidence", async () => {
    const starts = Array.from({ length: 65 }, (_, index) => ({
      type: "mcp_tool_use",
      id: `message-send-${index}`,
      name: "mcp__openclaw__message",
      input: {
        action: "send",
        channel: "telegram",
        target: `chat${index}`,
        message: "done",
      },
    }));
    const results = starts.map((start) => ({
      type: "mcp_tool_result",
      tool_use_id: start.id,
      content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
    }));
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [...starts, ...results] },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.messagingToolSentTargets).toHaveLength(64);
    expect(result.messagingToolSentTargets?.[0]?.to).toBe("chat1");
    expect(result.messagingToolSentTargets?.at(-1)?.to).toBe("chat64");
  });

  it("fails closed when an unresolved JSONL message send is evicted", async () => {
    const starts = Array.from({ length: 65 }, (_, index) => ({
      type: "mcp_tool_use",
      id: `message-send-${index}`,
      name: "mcp__openclaw__message",
      input: {
        action: "send",
        channel: "telegram",
        target: `chat${index}`,
        message: "done",
      },
    }));
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            ...starts,
            {
              type: "mcp_tool_result",
              tool_use_id: starts[0]?.id,
              content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
            },
          ],
        },
      })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(true);
  });

  it("fails closed when a JSONL message send remains unresolved after exit", async () => {
    const chunk = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_tool_use",
            id: "message-send-unresolved",
            name: "mcp__openclaw__message",
            input: {
              action: "send",
              channel: "telegram",
              target: "chat123",
              message: "done",
            },
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(chunk);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(true);
  });

  it("keeps an unresolved JSONL dry-run message retryable", async () => {
    const chunk = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_tool_use",
            id: "message-dry-run-unresolved",
            name: "mcp__openclaw__message",
            input: {
              action: "send",
              channel: "telegram",
              target: "chat123",
              message: "done",
              dryRun: true,
            },
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(chunk);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBeUndefined();
  });

  it("fails closed for suppressed non-streaming MCP message results", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { status: "suppressed" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBeUndefined();
    expect(result.messagingToolSentTargets).toBeUndefined();
  });

  it("records sessions_yield through the serialized MCP capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureHandle = markMcpLoopbackRequestStarted(input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY);
      await resolveMcpLoopbackYieldContext(captureHandle)?.onYield("waiting on subagents");
      markMcpLoopbackRequestFinished(captureHandle);
      input.onStdout?.("yield acknowledged");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.yielded).toBe(true);
  });

  it("keeps mutation delivery out of sent-reply dedupe evidence", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "edit",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { ok: true },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toBeUndefined();
    expect(result.messagingToolSentTargets).toBeUndefined();
  });

  it("preserves the current provider for implicit message send targets", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.messageChannel = "slack";
    context.params.currentChannelId = "C123";
    context.params.currentThreadTs = "1700000000.000100";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          target: "C123",
          message: "done",
        },
        result: { status: "sent" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        provider: "slack",
        to: "C123",
      }),
    ]);
  });

  it("preserves partial delivery evidence from failed MCP message calls", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
          mediaUrl: "https://example.com/photo.png",
        },
        result: Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
        isError: true,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
        mediaUrls: ["https://example.com/photo.png"],
      }),
    ]);
  });

  it("reports confirmed non-streaming MCP message results from the serialized capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { result: { messageId: "msg-1" } },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
      }),
    ]);
  });

  it("reports confirmed poll delivery from the serialized capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "poll",
          channel: "telegram",
          target: "chat123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
        },
        result: { pollId: "poll-1" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it.each([
    {
      action: "reply",
      args: {
        action: "reply",
        channel: "telegram",
        target: "chat123",
        message: "done",
      },
    },
    {
      action: "sticker",
      args: {
        action: "sticker",
        channel: "telegram",
        target: "chat123",
        stickerId: "sticker-1",
      },
    },
  ] as const)("records target evidence for confirmed $action delivery", async ({ args }) => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
      const input = spawnArgs[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args,
        result: { ok: true },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toBeUndefined();
    expect(result.messagingToolSentMediaUrls).toBeUndefined();
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it("records target evidence for confirmed conversation creation", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
      const input = spawnArgs[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "thread-create",
          channel: "telegram",
          target: "chat123",
          message: "new thread",
        },
        result: { ok: true, thread: { id: "thread-1" } },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it("records current-target evidence for confirmed implicit reply delivery", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.messageChannel = "telegram";
    context.params.currentChannelId = "chat123";
    supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
      const input = spawnArgs[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "reply",
          message: "done",
        },
        result: { ok: true },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it("preserves text and media evidence for confirmed implicit message sends", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "implicit reply",
          mediaUrl: "https://example.com/implicit.png",
        },
        result: {
          ok: true,
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: {
              text: "implicit reply",
              mediaUrl: "https://example.com/implicit.png",
            },
          },
        },
        isError: false,
      });
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "implicit reply",
          mediaUrl: "https://example.com/implicit.png",
        },
        result: {
          ok: true,
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: {
              text: "implicit reply",
              mediaUrl: "https://example.com/implicit.png",
            },
          },
        },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["implicit reply"]);
    expect(result.messagingToolSentMediaUrls).toEqual(["https://example.com/implicit.png"]);
    expect(result.messagingToolSentTargets).toBeUndefined();
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "implicit reply",
        mediaUrl: "https://example.com/implicit.png",
      },
      {
        text: "implicit reply",
        mediaUrl: "https://example.com/implicit.png",
      },
    ]);
  });

  it("retains confirmed delivery for long non-streaming message calls", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "local-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "x".repeat(20 * 1024),
        },
        result: { status: "sent" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({ tool: "message", provider: "telegram", to: "chat123" }),
    ]);
  });

  it("captures non-Claude JSONL sends and gives every attempt a unique token", async () => {
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "local-cli" });
    context.mcpDeliveryCapture = true;
    const captureKeys: string[] = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      captureKeys.push(captureKey);
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { status: "sent" },
        isError: false,
      });
      input.onStdout?.(`${JSON.stringify({ item: { type: "message", text: "done" } })}\n`);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const first = await executePreparedCliRun(context);
    const second = await executePreparedCliRun(context);

    expect(first.didSendViaMessagingTool).toBe(true);
    expect(second.didSendViaMessagingTool).toBe(true);
    expect(captureKeys).toHaveLength(2);
    expect(captureKeys[0]).not.toBe(captureKeys[1]);
  });
});
