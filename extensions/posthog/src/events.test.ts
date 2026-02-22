import { describe, expect, test, vi } from "vitest";

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-0001"),
}));

import type {
  DiagnosticMessageProcessedEvent,
  PluginHookAfterToolCallEvent,
  PluginHookLlmOutputEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk";
import { buildAiGeneration, buildAiSpan, buildAiTrace, mapStopReason } from "./events.js";
import type { LastAssistantInfo, RunState } from "./types.js";

describe("buildAiGeneration", () => {
  const baseRunState: RunState = {
    traceId: "trace-1",
    spanId: "span-1",
    startTime: Date.now() - 1500,
    model: "gpt-4o",
    provider: "openai",
    input: [{ role: "user", content: "hello" }],
    sessionKey: "telegram:123",
    sessionId: "telegram:123:abc12345",
    channel: "telegram",
    agentId: "agent-1",
  };

  const baseOutput: PluginHookLlmOutputEvent = {
    runId: "run-1",
    sessionId: "sess-1",
    provider: "openai",
    model: "gpt-4o",
    assistantTexts: ["Hello! How can I help?"],
    usage: {
      input: 100,
      output: 25,
      cacheRead: 50,
      cacheWrite: 10,
      total: 185,
    },
  };

  test("maps all fields correctly with privacy off", () => {
    const result = buildAiGeneration(baseRunState, baseOutput, false);

    expect(result.event).toBe("$ai_generation");
    expect(result.distinctId).toBe("telegram:123:abc12345");
    expect(result.properties.$ai_trace_id).toBe("trace-1");
    expect(result.properties.$ai_span_id).toBe("span-1");
    expect(result.properties.$ai_model).toBe("gpt-4o");
    expect(result.properties.$ai_provider).toBe("openai");
    expect(result.properties.$ai_input).toEqual([{ role: "user", content: "hello" }]);
    expect(result.properties.$ai_output_choices).toEqual([
      { role: "assistant", content: "Hello! How can I help?" },
    ]);
    expect(result.properties.$ai_input_tokens).toBe(100);
    expect(result.properties.$ai_output_tokens).toBe(25);
    expect(result.properties.$ai_latency).toBeGreaterThan(0);
    expect(result.properties.$ai_is_error).toBe(false);
    expect(result.properties.$ai_lib).toBe("posthog-openclaw");
    expect(result.properties.$ai_framework).toBe("openclaw");
    expect(result.properties.cache_read_input_tokens).toBe(50);
    expect(result.properties.cache_creation_input_tokens).toBe(10);
    expect(result.properties.$ai_channel).toBe("telegram");
    expect(result.properties.$ai_agent_id).toBe("agent-1");
  });

  test("normalizes raw OpenClaw messages to OpenAI format", () => {
    const rawInput: unknown[] = [
      // OpenClaw user message with content array + extra fields
      {
        role: "user",
        content: [{ type: "text", text: "hi there" }],
        timestamp: 1234567890,
      },
      // OpenClaw assistant message with thinking + text + extra metadata
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Hello!" },
        ],
        api: "openai-completions",
        model: "gpt-4o",
        provider: "openai",
        stopReason: "stop",
        timestamp: 1234567891,
        usage: { input: 100, output: 25 },
      },
      // Bare string prompt (current user message)
      "what is 2+2?",
    ];

    const runState: RunState = {
      ...baseRunState,
      input: rawInput,
    };
    const result = buildAiGeneration(runState, baseOutput, false);
    const input = result.properties.$ai_input as Array<{ role: string; content: unknown }>;

    expect(input).toHaveLength(3);
    // User message: content array with single text item simplified to string
    expect(input[0]).toEqual({ role: "user", content: "hi there" });
    // Assistant message: thinking stripped, only text remains (simplified to string)
    expect(input[1]).toEqual({ role: "assistant", content: "Hello!" });
    // Bare string normalized to user message
    expect(input[2]).toEqual({ role: "user", content: "what is 2+2?" });
  });

  test("converts Anthropic tool_use/tool_result to OpenAI format", () => {
    const rawInput: unknown[] = [
      { role: "user", content: "search for weather" },
      // Anthropic-style assistant turn with tool_use
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search..." },
          { type: "tool_use", id: "call_1", name: "web_search", input: { query: "weather" } },
        ],
      },
      // Anthropic-style user turn with tool_result
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny, 22°C" }],
      },
      // Final assistant text response
      { role: "assistant", content: "It's sunny and 22°C!" },
    ];

    const runState: RunState = { ...baseRunState, input: rawInput };
    const result = buildAiGeneration(runState, baseOutput, false);
    const input = result.properties.$ai_input as Array<Record<string, unknown>>;

    // [0] user text → stays as-is
    expect(input[0]).toEqual({ role: "user", content: "search for weather" });
    // [1] assistant with tool_calls (OpenAI format)
    expect(input[1]).toMatchObject({
      role: "assistant",
      content: "Let me search...",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: '{"query":"weather"}' },
        },
      ],
    });
    // [2] tool result → role:"tool" (OpenAI format)
    expect(input[2]).toEqual({
      role: "tool",
      content: "Sunny, 22°C",
      tool_call_id: "call_1",
    });
    // [3] final assistant text
    expect(input[3]).toEqual({ role: "assistant", content: "It's sunny and 22°C!" });
  });

  test("converts OpenClaw toolCall/toolResult to OpenAI format", () => {
    const rawInput: unknown[] = [
      { role: "user", content: "read my identity file" },
      // OpenClaw-style assistant turn with toolCall (camelCase, arguments instead of input)
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolu_vrtx_01",
            name: "read",
            arguments: { file_path: "IDENTITY.md" },
          },
        ],
      },
      // OpenClaw-style tool result (role: "toolResult", flat message) with toolCallId
      {
        role: "toolResult",
        toolCallId: "toolu_vrtx_01",
        content: "# IDENTITY.md\nName: Sir Hogsalot",
      },
      { role: "assistant", content: "Your name is Sir Hogsalot!" },
    ];

    const runState: RunState = { ...baseRunState, input: rawInput };
    const result = buildAiGeneration(runState, baseOutput, false);
    const input = result.properties.$ai_input as Array<Record<string, unknown>>;

    // [0] user text
    expect(input[0]).toEqual({ role: "user", content: "read my identity file" });
    // [1] assistant with tool_calls (converted from toolCall)
    expect(input[1]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "toolu_vrtx_01",
          type: "function",
          function: { name: "read", arguments: '{"file_path":"IDENTITY.md"}' },
        },
      ],
    });
    // [2] toolResult → role:"tool" with tool_call_id preserved
    expect(input[2]).toEqual({
      role: "tool",
      content: "# IDENTITY.md\nName: Sir Hogsalot",
      tool_call_id: "toolu_vrtx_01",
    });
    // [3] final assistant text
    expect(input[3]).toEqual({ role: "assistant", content: "Your name is Sir Hogsalot!" });
  });

  test("toolResult with toolUseId maps to tool_call_id", () => {
    const rawInput: unknown[] = [
      { role: "toolResult", toolUseId: "call_abc123", content: "result data" },
    ];

    const runState: RunState = { ...baseRunState, input: rawInput };
    const result = buildAiGeneration(runState, baseOutput, false);
    const input = result.properties.$ai_input as Array<Record<string, unknown>>;

    expect(input[0]).toEqual({
      role: "tool",
      content: "result data",
      tool_call_id: "call_abc123",
    });
  });

  test("toolResult without toolCallId omits tool_call_id", () => {
    const rawInput: unknown[] = [{ role: "toolResult", content: "result without correlation" }];

    const runState: RunState = { ...baseRunState, input: rawInput };
    const result = buildAiGeneration(runState, baseOutput, false);
    const input = result.properties.$ai_input as Array<Record<string, unknown>>;

    expect(input[0]).toEqual({
      role: "tool",
      content: "result without correlation",
    });
  });

  test("skips assistant turns with only thinking blocks (empty content)", () => {
    const rawInput: unknown[] = [
      { role: "user", content: "hello" },
      // Assistant turn with only thinking — produces empty content
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Hmm..." }],
      },
      { role: "assistant", content: "Hi!" },
    ];

    const runState: RunState = { ...baseRunState, input: rawInput };
    const result = buildAiGeneration(runState, baseOutput, false);
    const input = result.properties.$ai_input as Array<{ role: string; content: unknown }>;

    // Thinking-only turn should be dropped
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ role: "user", content: "hello" });
    expect(input[1]).toEqual({ role: "assistant", content: "Hi!" });
  });

  test("redacts input/output in privacy mode", () => {
    const result = buildAiGeneration(baseRunState, baseOutput, true);

    expect(result.properties.$ai_input).toBeNull();
    expect(result.properties.$ai_output_choices).toBeNull();
    // Tokens should still be present
    expect(result.properties.$ai_input_tokens).toBe(100);
    expect(result.properties.$ai_output_tokens).toBe(25);
  });

  test("uses runId as distinctId when sessionKey missing", () => {
    const runState = { ...baseRunState, sessionKey: undefined, sessionId: undefined };
    const result = buildAiGeneration(runState, baseOutput, false);
    expect(result.distinctId).toBe("run-1");
  });

  test("handles missing usage gracefully", () => {
    const output = { ...baseOutput, usage: undefined };
    const result = buildAiGeneration(baseRunState, output, false);
    expect(result.properties.$ai_input_tokens).toBeNull();
    expect(result.properties.$ai_output_tokens).toBeNull();
    expect(result.properties.cache_read_input_tokens).toBeNull();
    expect(result.properties.cache_creation_input_tokens).toBeNull();
  });

  test("includes cost properties when lastAssistant has cost data", () => {
    const lastAssistant: LastAssistantInfo = {
      stopReason: "stop",
      cost: { input: 0.001, output: 0.002, total: 0.003 },
    };
    const result = buildAiGeneration(baseRunState, baseOutput, false, lastAssistant);

    expect(result.properties.$ai_total_cost_usd).toBe(0.003);
    expect(result.properties.$ai_input_cost_usd).toBe(0.001);
    expect(result.properties.$ai_output_cost_usd).toBe(0.002);
  });

  test("includes null cost when no cost data", () => {
    const result = buildAiGeneration(baseRunState, baseOutput, false, {});

    expect(result.properties.$ai_total_cost_usd).toBeNull();
    expect(result.properties.$ai_input_cost_usd).toBeNull();
    expect(result.properties.$ai_output_cost_usd).toBeNull();
  });

  test("sets $ai_is_error true and $ai_error when stopReason is error", () => {
    const lastAssistant: LastAssistantInfo = {
      stopReason: "error",
      errorMessage: "Rate limit exceeded",
    };
    const result = buildAiGeneration(baseRunState, baseOutput, false, lastAssistant);

    expect(result.properties.$ai_is_error).toBe(true);
    expect(result.properties.$ai_error).toBe("Rate limit exceeded");
    expect(result.properties.$ai_stop_reason).toBe("error");
  });

  test("sets $ai_is_error false for non-error stopReasons", () => {
    const lastAssistant: LastAssistantInfo = { stopReason: "stop" };
    const result = buildAiGeneration(baseRunState, baseOutput, false, lastAssistant);

    expect(result.properties.$ai_is_error).toBe(false);
    expect(result.properties.$ai_error).toBeNull();
  });

  test("maps stop reason correctly with defaults", () => {
    // No lastAssistant → null stop reason
    const result = buildAiGeneration(baseRunState, baseOutput, false);
    expect(result.properties.$ai_stop_reason).toBeNull();
  });
});

describe("mapStopReason", () => {
  test.each([
    ["stop", "stop"],
    ["length", "length"],
    ["toolUse", "tool_calls"],
    ["error", "error"],
    ["aborted", "stop"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(mapStopReason(input)).toBe(expected);
  });

  test("returns null for undefined", () => {
    expect(mapStopReason(undefined)).toBeNull();
  });

  test("passes through unknown values", () => {
    expect(mapStopReason("custom_reason")).toBe("custom_reason");
  });
});

describe("buildAiSpan", () => {
  const baseToolEvent: PluginHookAfterToolCallEvent = {
    toolName: "web_search",
    params: { query: "weather today" },
    result: { results: ["sunny"] },
    durationMs: 320,
  };

  const baseToolCtx: PluginHookToolContext = {
    toolName: "web_search",
    sessionKey: "telegram:123",
    agentId: "agent-1",
  };

  test("maps tool call to span correctly", () => {
    const result = buildAiSpan("trace-1", "parent-span-1", baseToolEvent, baseToolCtx, false);

    expect(result.event).toBe("$ai_span");
    expect(result.distinctId).toBe("telegram:123");
    expect(result.properties.$ai_trace_id).toBe("trace-1");
    expect(result.properties.$ai_span_id).toBe("test-uuid-0001");
    expect(result.properties.$ai_parent_id).toBe("parent-span-1");
    expect(result.properties.$ai_span_name).toBe("web_search");
    expect(result.properties.$ai_latency).toBeCloseTo(0.32, 2);
    expect(result.properties.$ai_is_error).toBe(false);
    expect(result.properties.$ai_error).toBeNull();
    expect(result.properties.$ai_input_state).toContain("weather today");
    expect(result.properties.$ai_output_state).toContain("sunny");
  });

  test("redacts input/output state in privacy mode", () => {
    const result = buildAiSpan("trace-1", "parent-1", baseToolEvent, baseToolCtx, true);

    expect(result.properties.$ai_input_state).toBeNull();
    expect(result.properties.$ai_output_state).toBeNull();
    // Duration still present
    expect(result.properties.$ai_latency).toBeCloseTo(0.32, 2);
  });

  test("marks error spans correctly", () => {
    const errorEvent = { ...baseToolEvent, error: "timeout", result: undefined };
    const result = buildAiSpan("trace-1", undefined, errorEvent, baseToolCtx, false);

    expect(result.properties.$ai_is_error).toBe(true);
    expect(result.properties.$ai_error).toBe("timeout");
    expect(result.properties.$ai_parent_id).toBeNull();
  });

  test("handles missing durationMs", () => {
    const event = { ...baseToolEvent, durationMs: undefined };
    const result = buildAiSpan("trace-1", "parent-1", event, baseToolCtx, false);
    expect(result.properties.$ai_latency).toBeNull();
  });
});

describe("buildAiTrace", () => {
  test("maps message.processed to trace event", () => {
    const diagnosticEvent = {
      type: "message.processed" as const,
      ts: Date.now(),
      seq: 1,
      channel: "telegram",
      outcome: "completed" as const,
      durationMs: 2500,
      sessionKey: "telegram:123",
    } satisfies DiagnosticMessageProcessedEvent;

    const result = buildAiTrace("trace-1", diagnosticEvent);

    expect(result.event).toBe("$ai_trace");
    expect(result.distinctId).toBe("telegram:123");
    expect(result.properties.$ai_trace_id).toBe("trace-1");
    expect(result.properties.$ai_latency).toBeCloseTo(2.5, 2);
    expect(result.properties.$ai_is_error).toBe(false);
    expect(result.properties.$ai_error).toBeNull();
    expect(result.properties.$ai_channel).toBe("telegram");
  });

  test("marks error traces correctly", () => {
    const diagnosticEvent = {
      type: "message.processed" as const,
      ts: Date.now(),
      seq: 2,
      channel: "slack",
      outcome: "error" as const,
      error: "model rate limited",
      durationMs: 500,
      sessionKey: "slack:456",
    } satisfies DiagnosticMessageProcessedEvent;

    const result = buildAiTrace("trace-2", diagnosticEvent);

    expect(result.properties.$ai_is_error).toBe(true);
    expect(result.properties.$ai_error).toBe("model rate limited");
  });

  test("handles missing durationMs", () => {
    const diagnosticEvent = {
      type: "message.processed" as const,
      ts: Date.now(),
      seq: 3,
      channel: "discord",
      outcome: "completed" as const,
    } satisfies DiagnosticMessageProcessedEvent;

    const result = buildAiTrace("trace-3", diagnosticEvent);
    expect(result.properties.$ai_latency).toBeNull();
  });

  test("includes token totals when provided", () => {
    const diagnosticEvent = {
      type: "message.processed" as const,
      ts: Date.now(),
      seq: 1,
      channel: "telegram",
      outcome: "completed" as const,
      durationMs: 2000,
      sessionKey: "telegram:123",
    } satisfies DiagnosticMessageProcessedEvent;

    const result = buildAiTrace("trace-1", diagnosticEvent, { input: 500, output: 150 });

    expect(result.properties.$ai_total_input_tokens).toBe(500);
    expect(result.properties.$ai_total_output_tokens).toBe(150);
  });

  test("has null token totals when not provided", () => {
    const diagnosticEvent = {
      type: "message.processed" as const,
      ts: Date.now(),
      seq: 1,
      channel: "telegram",
      outcome: "completed" as const,
      sessionKey: "telegram:123",
    } satisfies DiagnosticMessageProcessedEvent;

    const result = buildAiTrace("trace-1", diagnosticEvent);

    expect(result.properties.$ai_total_input_tokens).toBeNull();
    expect(result.properties.$ai_total_output_tokens).toBeNull();
  });
});
