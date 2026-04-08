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
