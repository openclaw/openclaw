// Performance timing file-log tests cover message/meta shaping for /tmp/openclaw logs.
import { describe, expect, it, vi } from "vitest";
import {
  buildPerformanceTimingLogMessage,
  buildPerformanceTimingLogMeta,
  diagnosticEventToTimingLogFields,
  logPerformanceTimingEvent,
} from "./timing-log.js";

describe("timing-log", () => {
  it("builds grep-friendly perf timing messages with runId and traceId", () => {
    const message = buildPerformanceTimingLogMessage({
      kind: "hook_handler",
      extensionId: "active-memory",
      hookName: "before_prompt_build",
      handlerName: "buildPrompt",
      handlerRef: "hook:active-memory:before_prompt_build@buildPrompt",
      durationMs: 42.5,
      outcome: "completed",
      runId: "run-abc",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      sessionKey: "agent:main:demo",
    });
    expect(message).toContain("perf timing:");
    expect(message).toContain("kind=hook_handler");
    expect(message).toContain("pluginId=active-memory");
    expect(message).toContain("hookName=before_prompt_build");
    expect(message).toContain("handlerRef=hook:active-memory:before_prompt_build@buildPrompt");
    expect(message).toContain("durationMs=42.5");
    expect(message).toContain("runId=run-abc");
    expect(message).toContain(`traceId=${"a".repeat(32)}`);
  });

  it("maps tool and llm diagnostic events", () => {
    expect(
      diagnosticEventToTimingLogFields({
        type: "tool.execution.completed",
        seq: 1,
        ts: 1,
        toolName: "read",
        toolSource: "core",
        handlerRef: "core:read",
        durationMs: 88,
        runId: "run-abc",
        toolCallId: "call-1",
      }),
    ).toMatchObject({
      kind: "tool",
      toolName: "read",
      handlerRef: "core:read",
      durationMs: 88,
      toolCallId: "call-1",
    });

    expect(
      diagnosticEventToTimingLogFields({
        type: "model.call.completed",
        seq: 2,
        ts: 2,
        provider: "openai",
        model: "gpt-5.5",
        providerPluginId: "openai",
        handlerRef: "provider-plugin:openai/responses",
        durationMs: 1500,
        runId: "run-abc",
        callId: "run-abc:model:1",
        trace: { traceId: "c".repeat(32) },
      }),
    ).toMatchObject({
      kind: "llm",
      provider: "openai",
      model: "gpt-5.5",
      traceId: "c".repeat(32),
      callId: "run-abc:model:1",
    });
  });

  it("writes structured meta including trace for file logger", () => {
    const meta = buildPerformanceTimingLogMeta({
      kind: "tool",
      extensionId: "core",
      toolName: "exec",
      durationMs: 24,
      runId: "run-abc",
      traceId: "d".repeat(32),
      spanId: "e".repeat(16),
    });
    expect(meta).toMatchObject({
      perfTiming: true,
      kind: "tool",
      runId: "run-abc",
      traceId: "d".repeat(32),
      trace: { traceId: "d".repeat(32), spanId: "e".repeat(16) },
      toolName: "exec",
      pluginId: "core",
      durationMs: 24,
    });
  });

  it("delegates to injected logger", () => {
    const logger = { info: vi.fn() };
    logPerformanceTimingEvent(logger, {
      kind: "llm",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 900,
      runId: "run-abc",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("kind=llm"),
      expect.objectContaining({ perfTiming: true, runId: "run-abc" }),
    );
  });
});
