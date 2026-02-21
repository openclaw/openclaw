import { beforeEach, describe, expect, test, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());
const shutdownMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const onDiagnosticEventMock = vi.hoisted(() => vi.fn());

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = captureMock;
    shutdown = shutdownMock;
  },
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    onDiagnosticEvent: onDiagnosticEventMock,
  };
});

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PostHogPluginConfig } from "./types.js";
import { registerPostHogHooks } from "./plugin.js";

type HookHandler = (event: unknown, ctx: unknown) => void | Promise<void>;
type ServiceDef = { id: string; start: () => Promise<void>; stop?: () => Promise<void> };

function createMockApi() {
  const hooks = new Map<string, HookHandler[]>();
  const services: ServiceDef[] = [];

  const api = {
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerService: vi.fn((svc: ServiceDef) => {
      services.push(svc);
    }),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      if (!hooks.has(hookName)) hooks.set(hookName, []);
      hooks.get(hookName)!.push(handler);
    }),
  } as unknown as OpenClawPluginApi;

  return { api, hooks, services };
}

function defaultConfig(overrides: Partial<PostHogPluginConfig> = {}): PostHogPluginConfig {
  return {
    apiKey: "phc_test",
    host: "https://us.i.posthog.com",
    privacyMode: false,
    enabled: true,
    traceGrouping: "message",
    sessionWindowMinutes: 60,
    ...overrides,
  };
}

describe("registerPostHogHooks", () => {
  beforeEach(() => {
    captureMock.mockClear();
    shutdownMock.mockClear();
    onDiagnosticEventMock.mockReset();
    onDiagnosticEventMock.mockReturnValue(vi.fn()); // unsubscribe fn
  });

  test("registers a service and all expected hooks", () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());

    expect(services).toHaveLength(1);
    expect(services[0]!.id).toBe("posthog");

    const registeredHooks = [...hooks.keys()];
    expect(registeredHooks).toContain("llm_input");
    expect(registeredHooks).toContain("llm_output");
    expect(registeredHooks).toContain("after_tool_call");
    expect(registeredHooks).not.toContain("message_received");
  });

  test("service start initializes PostHog client", async () => {
    const { api, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());

    await services[0]!.start();

    expect(onDiagnosticEventMock).toHaveBeenCalledTimes(1);
  });

  test("service stop shuts down PostHog client", async () => {
    const { api, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());

    await services[0]!.start();
    await services[0]!.stop?.();

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  test("llm_input + llm_output captures $ai_generation", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    // Fire llm_input
    const llmInputHandlers = hooks.get("llm_input")!;
    await llmInputHandlers[0]!(
      {
        runId: "run-1",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        prompt: "What is 2+2?",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:123", agentId: "agent-1", messageProvider: "telegram" },
    );

    // Fire llm_output
    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "run-1",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["4"],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      },
      { sessionKey: "telegram:123", agentId: "agent-1" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.event).toBe("$ai_generation");
    // distinctId is windowed session ID
    expect(captured.distinctId).toMatch(/^telegram:123:[a-z0-9-]{8}$/);
    expect(captured.properties.$ai_model).toBe("gpt-4o");
    expect(captured.properties.$ai_input_tokens).toBe(10);
    expect(captured.properties.$ai_output_tokens).toBe(5);
    expect(captured.properties.$ai_input).toEqual([{ role: "user", content: "What is 2+2?" }]);
    expect(captured.properties.$ai_output_choices).toEqual([{ role: "assistant", content: "4" }]);
    // Session ID is windowed: "sessionKey:windowId"
    expect(captured.properties.$ai_session_id).toMatch(/^telegram:123:[a-z0-9-]{8}$/);
  });

  test("separate messages (different runIds) get distinct trace IDs", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    const llmInputHandlers = hooks.get("llm_input")!;
    const llmOutputHandlers = hooks.get("llm_output")!;

    // First message (runId "run-a")
    await llmInputHandlers[0]!(
      {
        runId: "run-a",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "agent:main:main" },
    );
    await llmOutputHandlers[0]!(
      {
        runId: "run-a",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["Hi!"],
        usage: { input: 5, output: 2 },
      },
      { sessionKey: "agent:main:main" },
    );

    const traceId1 = captureMock.mock.calls[0]![0].properties.$ai_trace_id;

    // Second message — same sessionKey but different runId
    await llmInputHandlers[0]!(
      {
        runId: "run-b",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Goodbye",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "agent:main:main" },
    );
    await llmOutputHandlers[0]!(
      {
        runId: "run-b",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["Bye!"],
        usage: { input: 5, output: 2 },
      },
      { sessionKey: "agent:main:main" },
    );

    const traceId2 = captureMock.mock.calls[1]![0].properties.$ai_trace_id;
    expect(traceId1).toBeTruthy();
    expect(traceId2).toBeTruthy();
    expect(traceId1).not.toBe(traceId2);

    // Both should have the same windowed session ID (within same window)
    const session1 = captureMock.mock.calls[0]![0].properties.$ai_session_id;
    const session2 = captureMock.mock.calls[1]![0].properties.$ai_session_id;
    expect(session1).toMatch(/^agent:main:main:[a-z0-9-]{8}$/);
    expect(session1).toBe(session2);
  });

  test("tool-use cycle (same runId) reuses the same trace ID", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    const llmInputHandlers = hooks.get("llm_input")!;
    const llmOutputHandlers = hooks.get("llm_output")!;

    // First LLM call — model requests tool use (same runId throughout)
    await llmInputHandlers[0]!(
      {
        runId: "run-tool",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        prompt: "What's the weather?",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:789" },
    );
    await llmOutputHandlers[0]!(
      {
        runId: "run-tool",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["Let me check..."],
        usage: { input: 10, output: 5 },
      },
      { sessionKey: "telegram:789" },
    );

    const traceId1 = captureMock.mock.calls[0]![0].properties.$ai_trace_id;

    // Second LLM call — after tool execution, same runId (same agent invocation)
    await llmInputHandlers[0]!(
      {
        runId: "run-tool",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Tool result: sunny",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:789" },
    );
    await llmOutputHandlers[0]!(
      {
        runId: "run-tool",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["It's sunny!"],
        usage: { input: 15, output: 5 },
      },
      { sessionKey: "telegram:789" },
    );

    const traceId2 = captureMock.mock.calls[1]![0].properties.$ai_trace_id;
    expect(traceId1).toBe(traceId2);
  });

  test("privacy mode redacts input/output content", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig({ privacyMode: true }));
    await services[0]!.start();

    const llmInputHandlers = hooks.get("llm_input")!;
    await llmInputHandlers[0]!(
      {
        runId: "run-2",
        sessionId: "sess-2",
        provider: "anthropic",
        model: "claude-3",
        prompt: "secret data",
        historyMessages: [{ role: "user", content: "private" }],
        imagesCount: 0,
      },
      { sessionKey: "slack:456" },
    );

    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "run-2",
        sessionId: "sess-2",
        provider: "anthropic",
        model: "claude-3",
        assistantTexts: ["secret response"],
        usage: { input: 20, output: 10 },
      },
      { sessionKey: "slack:456" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.properties.$ai_input).toBeNull();
    expect(captured.properties.$ai_output_choices).toBeNull();
    expect(captured.properties.$ai_input_tokens).toBe(20);
  });

  test("after_tool_call captures $ai_span", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    // Set up a trace by triggering llm_input first
    const llmInputHandlers = hooks.get("llm_input")!;
    await llmInputHandlers[0]!(
      {
        runId: "run-3",
        sessionId: "sess-3",
        provider: "openai",
        model: "gpt-4o",
        prompt: "search for weather",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:789", agentId: "agent-1", messageProvider: "telegram" },
    );

    // Complete the generation to set up parent span
    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "run-3",
        sessionId: "sess-3",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["Let me search..."],
        usage: { input: 10, output: 5 },
      },
      { sessionKey: "telegram:789" },
    );

    captureMock.mockClear();

    // Fire after_tool_call
    const toolCallHandlers = hooks.get("after_tool_call")!;
    await toolCallHandlers[0]!(
      {
        toolName: "web_search",
        params: { query: "weather" },
        result: { answer: "sunny" },
        durationMs: 250,
      },
      { sessionKey: "telegram:789", toolName: "web_search", agentId: "agent-1" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.event).toBe("$ai_span");
    expect(captured.properties.$ai_span_name).toBe("web_search");
    expect(captured.properties.$ai_latency).toBeCloseTo(0.25, 2);
    expect(captured.properties.$ai_parent_id).toBeTruthy();
  });

  test("diagnostic message.processed captures $ai_trace", async () => {
    const { api, hooks, services } = createMockApi();
    let diagnosticListener: (evt: unknown) => void = () => {};
    onDiagnosticEventMock.mockImplementation((fn: (evt: unknown) => void) => {
      diagnosticListener = fn;
      return vi.fn();
    });

    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    // Set up trace via llm_input (creates trace for this sessionKey)
    const llmInputHandlers = hooks.get("llm_input")!;
    await llmInputHandlers[0]!(
      {
        runId: "run-trace",
        sessionId: "sess-trace",
        provider: "openai",
        model: "gpt-4o",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:trace-test" },
    );

    // Complete the run (so trace exists)
    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "run-trace",
        sessionId: "sess-trace",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["hi"],
        usage: { input: 5, output: 2 },
      },
      { sessionKey: "telegram:trace-test" },
    );

    captureMock.mockClear();

    // Trigger diagnostic event with matching sessionKey
    diagnosticListener({
      type: "message.processed",
      ts: Date.now(),
      seq: 1,
      channel: "telegram",
      outcome: "completed",
      durationMs: 3000,
      sessionKey: "telegram:trace-test",
    });

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.event).toBe("$ai_trace");
    expect(captured.properties.$ai_latency).toBeCloseTo(3.0, 2);
    expect(captured.properties.$ai_is_error).toBe(false);
    // Session ID is windowed
    expect(captured.properties.$ai_session_id).toMatch(/^telegram:trace-test:[a-z0-9-]{8}$/);
  });

  test("generation event includes cost from lastAssistant", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    const llmInputHandlers = hooks.get("llm_input")!;
    await llmInputHandlers[0]!(
      {
        runId: "run-cost",
        sessionId: "sess-cost",
        provider: "anthropic",
        model: "claude-3",
        prompt: "Hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:cost-test" },
    );

    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "run-cost",
        sessionId: "sess-cost",
        provider: "anthropic",
        model: "claude-3",
        assistantTexts: ["Hi!"],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        lastAssistant: {
          stopReason: "stop",
          usage: {
            input: 100,
            output: 50,
            totalTokens: 150,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
        },
      },
      { sessionKey: "telegram:cost-test" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.properties.$ai_total_cost_usd).toBe(0.003);
    expect(captured.properties.$ai_input_cost_usd).toBe(0.001);
    expect(captured.properties.$ai_output_cost_usd).toBe(0.002);
    expect(captured.properties.$ai_stop_reason).toBe("stop");
    expect(captured.properties.$ai_is_error).toBe(false);
  });

  test("generation event shows error state when lastAssistant.stopReason is error", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    const llmInputHandlers = hooks.get("llm_input")!;
    await llmInputHandlers[0]!(
      {
        runId: "run-err",
        sessionId: "sess-err",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:err-test" },
    );

    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "run-err",
        sessionId: "sess-err",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: [],
        usage: { input: 10, output: 0 },
        lastAssistant: {
          stopReason: "error",
          errorMessage: "Context window exceeded",
        },
      },
      { sessionKey: "telegram:err-test" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.properties.$ai_is_error).toBe(true);
    expect(captured.properties.$ai_error).toBe("Context window exceeded");
    expect(captured.properties.$ai_stop_reason).toBe("error");
  });

  test("trace token totals accumulate across multiple generations", async () => {
    const { api, hooks, services } = createMockApi();
    let diagnosticListener: (evt: unknown) => void = () => {};
    onDiagnosticEventMock.mockImplementation((fn: (evt: unknown) => void) => {
      diagnosticListener = fn;
      return vi.fn();
    });

    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    const llmInputHandlers = hooks.get("llm_input")!;
    const llmOutputHandlers = hooks.get("llm_output")!;

    // First generation (same runId = same trace)
    await llmInputHandlers[0]!(
      {
        runId: "run-tokens",
        sessionId: "sess-tokens",
        provider: "openai",
        model: "gpt-4o",
        prompt: "search weather",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:token-test" },
    );
    await llmOutputHandlers[0]!(
      {
        runId: "run-tokens",
        sessionId: "sess-tokens",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["Let me check..."],
        usage: { input: 100, output: 50 },
      },
      { sessionKey: "telegram:token-test" },
    );

    // Second generation (same runId = same trace, tokens accumulate)
    await llmInputHandlers[0]!(
      {
        runId: "run-tokens",
        sessionId: "sess-tokens",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Tool result: sunny",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "telegram:token-test" },
    );
    await llmOutputHandlers[0]!(
      {
        runId: "run-tokens",
        sessionId: "sess-tokens",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["It's sunny!"],
        usage: { input: 200, output: 75 },
      },
      { sessionKey: "telegram:token-test" },
    );

    captureMock.mockClear();

    // Trigger trace event
    diagnosticListener({
      type: "message.processed",
      ts: Date.now(),
      seq: 1,
      channel: "telegram",
      outcome: "completed",
      durationMs: 5000,
      sessionKey: "telegram:token-test",
    });

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0];
    expect(captured.event).toBe("$ai_trace");
    expect(captured.properties.$ai_total_input_tokens).toBe(300);
    expect(captured.properties.$ai_total_output_tokens).toBe(125);
  });

  test("llm_output without matching llm_input is ignored", async () => {
    const { api, hooks, services } = createMockApi();
    registerPostHogHooks(api, defaultConfig());
    await services[0]!.start();

    const llmOutputHandlers = hooks.get("llm_output")!;
    await llmOutputHandlers[0]!(
      {
        runId: "no-matching-input",
        sessionId: "sess-x",
        provider: "openai",
        model: "gpt-4o",
        assistantTexts: ["orphan response"],
      },
      { sessionKey: "telegram:999" },
    );

    expect(captureMock).not.toHaveBeenCalled();
  });

  describe("traceGrouping: session", () => {
    test("different runIds within timeout share the same trace", async () => {
      const { api, hooks, services } = createMockApi();
      registerPostHogHooks(
        api,
        defaultConfig({ traceGrouping: "session", sessionWindowMinutes: 60 }),
      );
      await services[0]!.start();

      const llmInputHandlers = hooks.get("llm_input")!;
      const llmOutputHandlers = hooks.get("llm_output")!;

      // First message (runId "run-a")
      await llmInputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "telegram:session-test" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Hi!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "telegram:session-test" },
      );

      const traceId1 = captureMock.mock.calls[0]![0].properties.$ai_trace_id;

      // Second message — different runId, within timeout
      await llmInputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "How are you?",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "telegram:session-test" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["I'm good!"],
          usage: { input: 5, output: 3 },
        },
        { sessionKey: "telegram:session-test" },
      );

      const traceId2 = captureMock.mock.calls[1]![0].properties.$ai_trace_id;
      expect(traceId1).toBeTruthy();
      expect(traceId2).toBeTruthy();
      expect(traceId1).toBe(traceId2);
    });

    test("message after timeout gets a new trace", async () => {
      const { api, hooks, services } = createMockApi();
      registerPostHogHooks(
        api,
        defaultConfig({ traceGrouping: "session", sessionWindowMinutes: 30 }),
      );
      await services[0]!.start();

      const llmInputHandlers = hooks.get("llm_input")!;
      const llmOutputHandlers = hooks.get("llm_output")!;

      // First message
      await llmInputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "telegram:timeout-test" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Hi!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "telegram:timeout-test" },
      );

      const traceId1 = captureMock.mock.calls[0]![0].properties.$ai_trace_id;

      // Advance time past the 30-minute timeout
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);

      // Second message — after timeout
      await llmInputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "I'm back",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "telegram:timeout-test" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Welcome back!"],
          usage: { input: 5, output: 3 },
        },
        { sessionKey: "telegram:timeout-test" },
      );

      const traceId2 = captureMock.mock.calls[1]![0].properties.$ai_trace_id;
      expect(traceId1).toBeTruthy();
      expect(traceId2).toBeTruthy();
      expect(traceId1).not.toBe(traceId2);

      vi.restoreAllMocks();
    });

    test("session window rotates after timeout", async () => {
      const { api, hooks, services } = createMockApi();
      registerPostHogHooks(
        api,
        defaultConfig({ traceGrouping: "session", sessionWindowMinutes: 1 }),
      );
      await services[0]!.start();

      const llmInputHandlers = hooks.get("llm_input")!;
      const llmOutputHandlers = hooks.get("llm_output")!;

      // First message
      await llmInputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "telegram:session-id-test" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Hi!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "telegram:session-id-test" },
      );

      // Advance past 1-minute timeout
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60_000);

      // Second message — new trace due to timeout
      await llmInputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Back again",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "telegram:session-id-test" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Welcome!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "telegram:session-id-test" },
      );

      // Different traces AND different session windows after timeout
      const session1 = captureMock.mock.calls[0]![0].properties.$ai_session_id;
      const session2 = captureMock.mock.calls[1]![0].properties.$ai_session_id;
      expect(session1).toMatch(/^telegram:session-id-test:[a-z0-9-]{8}$/);
      expect(session2).toMatch(/^telegram:session-id-test:[a-z0-9-]{8}$/);
      expect(session1).not.toBe(session2);

      const traceId1 = captureMock.mock.calls[0]![0].properties.$ai_trace_id;
      const traceId2 = captureMock.mock.calls[1]![0].properties.$ai_trace_id;
      expect(traceId1).not.toBe(traceId2);

      vi.restoreAllMocks();
    });
  });

  describe("session windowing in message mode", () => {
    test("messages within window share the same session ID", async () => {
      const { api, hooks, services } = createMockApi();
      registerPostHogHooks(api, defaultConfig({ sessionWindowMinutes: 60 }));
      await services[0]!.start();

      const llmInputHandlers = hooks.get("llm_input")!;
      const llmOutputHandlers = hooks.get("llm_output")!;

      // First message
      await llmInputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "agent:main:main" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Hi!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "agent:main:main" },
      );

      // Second message — different runId, within window
      await llmInputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "How are you?",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "agent:main:main" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Good!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "agent:main:main" },
      );

      const session1 = captureMock.mock.calls[0]![0].properties.$ai_session_id;
      const session2 = captureMock.mock.calls[1]![0].properties.$ai_session_id;
      expect(session1).toMatch(/^agent:main:main:[a-z0-9-]{8}$/);
      expect(session1).toBe(session2);

      // But different trace IDs (message mode splits on runId)
      const traceId1 = captureMock.mock.calls[0]![0].properties.$ai_trace_id;
      const traceId2 = captureMock.mock.calls[1]![0].properties.$ai_trace_id;
      expect(traceId1).not.toBe(traceId2);
    });

    test("message after window timeout gets a new session ID", async () => {
      const { api, hooks, services } = createMockApi();
      registerPostHogHooks(api, defaultConfig({ sessionWindowMinutes: 30 }));
      await services[0]!.start();

      const llmInputHandlers = hooks.get("llm_input")!;
      const llmOutputHandlers = hooks.get("llm_output")!;

      // First message
      await llmInputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "agent:main:main" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-a",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Hi!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "agent:main:main" },
      );

      const session1 = captureMock.mock.calls[0]![0].properties.$ai_session_id;

      // Advance past 30-minute window
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);

      // Second message — after window timeout
      await llmInputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          prompt: "I'm back",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "agent:main:main" },
      );
      await llmOutputHandlers[0]!(
        {
          runId: "run-b",
          sessionId: "sess-1",
          provider: "openai",
          model: "gpt-4o",
          assistantTexts: ["Welcome back!"],
          usage: { input: 5, output: 2 },
        },
        { sessionKey: "agent:main:main" },
      );

      const session2 = captureMock.mock.calls[1]![0].properties.$ai_session_id;
      expect(session1).toMatch(/^agent:main:main:[a-z0-9-]{8}$/);
      expect(session2).toMatch(/^agent:main:main:[a-z0-9-]{8}$/);
      expect(session1).not.toBe(session2);

      vi.restoreAllMocks();
    });
  });
});
