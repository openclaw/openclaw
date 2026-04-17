import { type ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi, beforeEach } from "vitest";
import plugin from "./index.js";
import { normalizeDatabricksBaseUrl } from "./onboard.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

/** Helper to wrap a Response in the GuardedFetchResult shape that fetchWithSsrFGuard returns. */
function mockFetchResult(response: Response): { response: Response; release: () => Promise<void> } {
  return { response, release: vi.fn(async () => {}) };
}

describe("Databricks plugin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("wrapStreamFn", () => {
    it("rewrites the URL to the invocations endpoint and handles streaming", async () => {
      const api = {
        registerProvider: vi.fn(),
      } as any;
      await plugin.register(api);

      const providerReg = api.registerProvider.mock.calls[0][0];
      const wrapStreamFn = providerReg.wrapStreamFn;
      expect(wrapStreamFn).toBeDefined();

      const model = {
        id: "test-model",
        baseUrl: "https://my-databricks.cloud.databricks.com",
        api: "openai-completions",
      } as any;
      const context = {
        messages: [{ role: "user", content: "hello" }],
      } as any;
      const options = {
        apiKey: "test-token",
        maxTokens: 100,
        temperature: 0.7,
      } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"role":"assistant","content":"Hi! "},"finish_reason":null}]}\n',
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"How can I help?"},"finish_reason":"stop"}]}\n',
                  ),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n"));
                controller.close();
              },
            }),
            { status: 200, statusText: "OK" },
          ),
        ),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      const eventStream = await streamFn(model, context, options);

      const iterableStream = eventStream as AsyncIterable<Record<string, unknown>>;
      const events: Record<string, unknown>[] = [];
      for await (const event of iterableStream) {
        events.push(event);
      }

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://my-databricks.cloud.databricks.com/serving-endpoints/test-model/invocations",
          init: expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              Authorization: "Bearer test-token",
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            }),
          }),
        }),
      );

      expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Hi! " }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "text_delta", delta: "How can I help?" }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: "done", reason: "stop" }));
    });

    it("handles streamed tool calls", async () => {
      const api = {
        registerProvider: vi.fn(),
      } as any;
      await plugin.register(api);

      const providerReg = api.registerProvider.mock.calls[0][0];
      const wrapStreamFn = providerReg.wrapStreamFn;

      const model = {
        id: "test-model",
        baseUrl: "https://my-databricks.cloud.databricks.com",
        api: "openai-completions",
      } as any;
      const context = { messages: [{ role: "user", content: "use a tool" }] } as any;
      const options = { apiKey: "test-token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Lo"}}]},"finish_reason":null}]}\n',
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"ndon\\"}"}}]},"finish_reason":"tool_calls"}]}\n',
                  ),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n"));
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      const eventStream = await streamFn(model, context, options);

      const iterableStream = eventStream as AsyncIterable<Record<string, unknown>>;
      const events: Record<string, unknown>[] = [];
      for await (const event of iterableStream) {
        events.push(event);
      }

      expect(events).toContainEqual(expect.objectContaining({ type: "toolcall_start" }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "toolcall_delta", delta: '{"city":"Lo' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "toolcall_delta", delta: 'ndon"}' }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: "done", reason: "toolUse" }));
    });

    it("handles interleaved parallel tool calls using index", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      const context = { messages: [{ role: "user", content: "parallel tools" }] } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                // Start Tool 0
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"f0","arguments":""}}]},"finish_reason":null}]}\n',
                  ),
                );
                // Start Tool 1
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"f1","arguments":""}}]},"finish_reason":null}]}\n',
                  ),
                );
                // Delta for Tool 0
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}\n',
                  ),
                );
                // Delta for Tool 1
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"b\\":2}"}}]},"finish_reason":null}]}\n',
                  ),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n"));
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      const eventStream = await streamFn(model, context, options);

      const iterableStream = eventStream as AsyncIterable<Record<string, unknown>>;
      const events: Record<string, unknown>[] = [];
      for await (const event of iterableStream) {
        events.push(event);
      }

      const toolStartEvents = events.filter((e) => e.type === "toolcall_start");
      expect(toolStartEvents).toHaveLength(2);
      expect(toolStartEvents[0].contentIndex).toBe(0);
      expect(toolStartEvents[1].contentIndex).toBe(1);

      const toolDeltaEvents = events.filter((e) => e.type === "toolcall_delta");
      expect(toolDeltaEvents).toHaveLength(2);
      // Tool 0 delta
      expect(toolDeltaEvents[0].contentIndex).toBe(0);
      expect(toolDeltaEvents[0].delta).toBe('{"a":1}');
      // Tool 1 delta
      expect(toolDeltaEvents[1].contentIndex).toBe(1);
      expect(toolDeltaEvents[1].delta).toBe('{"b":2}');
    });

    it("includes systemPrompt and maps toolResult role", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = {
        id: "test",
        baseUrl: "https://test.com",
        api: "openai-completions",
        headers: { "X-Model-Header": "foo" },
      } as any;
      const context = {
        systemPrompt: "You are a helpful assistant",
        messages: [
          { role: "user", content: "call tool" },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "call_1", function: { name: "t1", arguments: "{}" } }],
          },
          { role: "toolResult", toolCallId: "call_1", content: "result" },
        ],
        tools: [{ name: "t1", description: "d1", parameters: {} }],
      } as any;
      const options = { apiKey: "token", headers: { "X-Options-Header": "bar" } } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(new Response("data: [DONE]\n", { status: 200 })),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          init: expect.objectContaining({
            headers: expect.objectContaining({
              "X-Model-Header": "foo",
              "X-Options-Header": "bar",
            }),
            body: expect.stringContaining(
              '"role":"system","content":"You are a helpful assistant"',
            ),
          }),
        }),
      );

      const callInit = fetchWithSsrFGuardMock.mock.calls[0][0].init;
      const body = JSON.parse(callInit.body);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[3].role).toBe("tool"); // toolResult -> tool
      expect(body.tools[0].type).toBe("function");
    });
  });

  describe("catalog", () => {
    it("filters to chat-capable models and maps to openai-completions api", async () => {
      const api = {
        registerProvider: vi.fn(),
      } as any;
      await plugin.register(api);

      const providerReg = api.registerProvider.mock.calls[0][0];
      const catalogRun = providerReg.catalog.run;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(
          new Response(
            JSON.stringify({
              endpoints: [
                { name: "chat-model", task: "llm/v1/chat" },
                { name: "legacy-model", task: "llm/v1/completions" },
                { name: "embedding-model", task: "llm/v1/embeddings" },
              ],
            }),
          ),
        ),
      );

      const ctx = {
        resolveProviderApiKey: () => ({ apiKey: "test-token" }),
        config: {
          models: {
            providers: {
              databricks: { baseUrl: "https://my-databricks.cloud.databricks.com" },
            },
          },
        },
      } as any;

      const result = await catalogRun(ctx);
      expect(result.provider.models).toHaveLength(1);
      expect(result.provider.models[0].name).toBe("chat-model");
      expect(result.provider.models[0].api).toBe("openai-completions");
    });
  });

  describe("replay normalization", () => {
    it("inserts synthetic tool-result stub for dangling assistant tool call", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      // history: assistant called a tool, but the session was interrupted before toolResult arrived
      const context = {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_x", name: "search", arguments: {} }],
            stopReason: "toolUse",
          },
          // No toolResult for call_x - this is the dangling case
          { role: "user", content: "what happened?" },
        ],
      } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(new Response("data: [DONE]\n", { status: 200 })),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      const sentBody = JSON.parse(fetchWithSsrFGuardMock.mock.calls[0][0].init.body);
      const roles = sentBody.messages.map((m: { role: string }) => m.role);
      // The synthetic stub should be inserted between assistant and user
      expect(roles).toContain("tool");
      const toolMsg = sentBody.messages.find(
        (m: { role: string; tool_call_id?: string }) => m.role === "tool",
      );
      expect(toolMsg?.tool_call_id).toBe("call_x");
    });

    it("strips thinking blocks before sending to Databricks", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      const context = {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should answer carefully.", redacted: false },
              { type: "text", text: "Here is my answer." },
            ],
            stopReason: "stop",
          },
          { role: "user", content: "follow-up" },
        ],
      } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(new Response("data: [DONE]\n", { status: 200 })),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      const sentBody = JSON.parse(fetchWithSsrFGuardMock.mock.calls[0][0].init.body);
      const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
      // Content should not contain any thinking-type objects
      expect(assistantMsg?.content).not.toMatch(/thinking/i);
    });

    it("flattens tool-result content blocks to text", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      const context = {
        messages: [
          { role: "user", content: "call tool" },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "search", arguments: {} }],
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [
              { type: "text", text: "first line" },
              { type: "image", data: "base64data" },
              { type: "text", text: " second line" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(new Response("data: [DONE]\n", { status: 200 })),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      const sentBody = JSON.parse(fetchWithSsrFGuardMock.mock.calls[0][0].init.body);
      const toolMsg = sentBody.messages.find((m: { role: string }) => m.role === "tool");
      // Content should be a flattened text string, not an array
      expect(typeof toolMsg?.content).toBe("string");
      expect(toolMsg?.content).toBe("first line second line");
      // Non-text blocks (like image) should be filtered out
      expect(toolMsg?.content).not.toContain("base64data");
    });

    it("serializes block-array user content to text instead of null", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      const context = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello " },
              { type: "text", text: "World" },
            ],
          },
        ],
      } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(new Response("data: [DONE]\n", { status: 200 })),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      const sentBody = JSON.parse(fetchWithSsrFGuardMock.mock.calls[0][0].init.body);
      const userMsg = sentBody.messages.find((m: { role: string }) => m.role === "user");
      // Block-array user content must be flattened to text, not sent as null
      expect(typeof userMsg?.content).toBe("string");
      expect(userMsg?.content).toBe("Hello World");
    });

    it("preserves plain-string assistant content from older transcripts", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      const context = {
        messages: [
          { role: "user", content: "hi" },
          // Older transcripts / some provider paths store assistant content as a plain string
          { role: "assistant", content: "Sure, I can help with that.", stopReason: "stop" },
          { role: "user", content: "thanks" },
        ],
      } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(new Response("data: [DONE]\n", { status: 200 })),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      const sentBody = JSON.parse(fetchWithSsrFGuardMock.mock.calls[0][0].init.body);
      const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
      // Plain-string content must survive normalization, not become null
      expect(assistantMsg?.content).toBe("Sure, I can help with that.");
    });
  });

  describe("SSE resilience", () => {
    it("skips malformed JSON lines without aborting the stream", async () => {
      const api = { registerProvider: vi.fn() } as any;
      await plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions" } as any;
      const context = { messages: [{ role: "user", content: "hello" }] } as any;
      const options = { apiKey: "token" } as any;

      fetchWithSsrFGuardMock.mockResolvedValue(
        mockFetchResult(
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n',
                  ),
                );
                controller.enqueue(encoder.encode("data: {INVALID_JSON\n"));
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":" World"},"finish_reason":"stop"}]}\n',
                  ),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n"));
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      );

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      const eventStream = await streamFn(model, context, options);

      const iterableStream = eventStream as AsyncIterable<Record<string, unknown>>;
      const events: Record<string, unknown>[] = [];
      for await (const event of iterableStream) {
        events.push(event);
      }

      // The stream should continue past the malformed line
      expect(events).toContainEqual(
        expect.objectContaining({ type: "text_delta", delta: "Hello" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "text_delta", delta: " World" }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: "done", reason: "stop" }));
    });
  });

  describe("normalizeDatabricksBaseUrl", () => {
    it("returns undefined for empty/whitespace input", () => {
      expect(normalizeDatabricksBaseUrl(undefined)).toBeUndefined();
      expect(normalizeDatabricksBaseUrl("")).toBeUndefined();
      expect(normalizeDatabricksBaseUrl("   ")).toBeUndefined();
    });

    it("prepends https:// when no scheme is provided", () => {
      expect(normalizeDatabricksBaseUrl("dbc-xxxx.cloud.databricks.com")).toBe(
        "https://dbc-xxxx.cloud.databricks.com",
      );
    });

    it("preserves https:// URLs", () => {
      expect(normalizeDatabricksBaseUrl("https://dbc-xxxx.cloud.databricks.com")).toBe(
        "https://dbc-xxxx.cloud.databricks.com",
      );
    });

    it("strips trailing slashes", () => {
      expect(normalizeDatabricksBaseUrl("https://dbc-xxxx.cloud.databricks.com///")).toBe(
        "https://dbc-xxxx.cloud.databricks.com",
      );
    });

    it("rejects http:// URLs to prevent credential exposure over cleartext", () => {
      expect(normalizeDatabricksBaseUrl("http://dbc-xxxx.cloud.databricks.com")).toBeUndefined();
      expect(normalizeDatabricksBaseUrl("http://localhost:8080")).toBeUndefined();
    });
  });
});
