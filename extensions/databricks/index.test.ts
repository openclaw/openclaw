import { describe, expect, it, vi, beforeEach } from "vitest";
import plugin from "./index.js";
import { type ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

vi.stubGlobal("fetch", vi.fn());

describe("Databricks plugin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("wrapStreamFn", () => {
    it("rewrites the URL to the invocations endpoint and handles streaming", async () => {
      const api = {
        registerProvider: vi.fn(),
      } as any;
      plugin.register(api);
      
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

      vi.stubGlobal("fetch", vi.fn(async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant","content":"Hi! "},"finish_reason":null}]}\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"How can I help?"},"finish_reason":"stop"}]}\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
          }
        });
        return new Response(stream, { status: 200, statusText: "OK" });
      }));

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      const eventStream = await streamFn(model, context, options);
      
      const events: any[] = [];
      for await (const event of (eventStream as any)) {
        events.push(event);
      }

      expect(fetch).toHaveBeenCalledWith(
        "https://my-databricks.cloud.databricks.com/serving-endpoints/test-model/invocations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Authorization": "Bearer test-token",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
          }),
          body: expect.stringContaining('"model":"test-model"'),
        })
      );

      expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Hi! " }));
      expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "How can I help?" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "done", reason: "stop" }));
    });

    it("handles streamed tool calls", async () => {
      const api = {
        registerProvider: vi.fn(),
      } as any;
      plugin.register(api);
      
      const providerReg = api.registerProvider.mock.calls[0][0];
      const wrapStreamFn = providerReg.wrapStreamFn;

      const model = { id: "test-model", baseUrl: "https://my-databricks.cloud.databricks.com", api: "openai-completions" } as any;
      const context = { messages: [{ role: "user", content: "use a tool" }] } as any;
      const options = { apiKey: "test-token" } as any;

      vi.stubGlobal("fetch", vi.fn(async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"London\\"}"}}]},"finish_reason":"tool_calls"}]}\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
          }
        });
        return new Response(stream, { status: 200 });
      }));

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      const eventStream = await streamFn(model, context, options);
      
      const events: any[] = [];
      for await (const event of (eventStream as any)) {
        events.push(event);
      }

      expect(events).toContainEqual(expect.objectContaining({ type: "toolcall_start" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "toolcall_delta", delta: '{"city":' }));
      expect(events).toContainEqual(expect.objectContaining({ type: "toolcall_delta", delta: '"London"}' }));
      expect(events).toContainEqual(expect.objectContaining({ type: "done", reason: "toolUse" }));
    });

    it("includes systemPrompt and maps toolResult role", async () => {
      const api = { registerProvider: vi.fn() } as any;
      plugin.register(api);
      const wrapStreamFn = api.registerProvider.mock.calls[0][0].wrapStreamFn;

      const model = { id: "test", baseUrl: "https://test.com", api: "openai-completions", headers: { "X-Model-Header": "foo" } } as any;
      const context = {
        systemPrompt: "You are a helpful assistant",
        messages: [
          { role: "user", content: "call tool" },
          { role: "assistant", content: null, toolCalls: [{ id: "call_1", function: { name: "t1", arguments: "{}" } }] },
          { role: "toolResult", toolCallId: "call_1", content: "result" }
        ],
        tools: [{ name: "t1", description: "d1", parameters: {} }]
      } as any;
      const options = { apiKey: "token", headers: { "X-Options-Header": "bar" } } as any;

      vi.stubGlobal("fetch", vi.fn(async () => new Response("data: [DONE]\n", { status: 200 })));

      const streamFn = wrapStreamFn({} as ProviderWrapStreamFnContext);
      await streamFn(model, context, options);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Model-Header": "foo",
            "X-Options-Header": "bar"
          }),
          body: expect.stringContaining('"role":"system","content":"You are a helpful assistant"'),
        })
      );

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
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
      plugin.register(api);
      
      const providerReg = api.registerProvider.mock.calls[0][0];
      const catalogRun = providerReg.catalog.run;

      vi.stubGlobal("fetch", vi.fn(async () => {
        return new Response(JSON.stringify({
          endpoints: [
            { name: "chat-model", task: "llm/v1/chat" },
            { name: "legacy-model", task: "llm/v1/completions" },
            { name: "embedding-model", task: "llm/v1/embeddings" },
          ]
        }));
      }));

      const ctx = {
        resolveProviderApiKey: () => ({ apiKey: "test-token" }),
        config: {
          models: {
            providers: {
              databricks: { baseUrl: "https://my-databricks.cloud.databricks.com" }
            }
          }
        }
      } as any;

      const result = await catalogRun(ctx);
      expect(result.provider.models).toHaveLength(1);
      expect(result.provider.models[0].name).toBe("chat-model");
      expect(result.provider.models[0].api).toBe("openai-completions");
    });
  });
});
