import { text as readText } from "node:stream/consumers";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { assert, describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import "./ai-transport-runtime-host.js";
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";

describe("custom simple completion thinking controls", () => {
  it.each([
    {
      provider: "zhipu",
      id: "glm-5.3-flash",
      baseUrl: "https://api.z.ai/api/paas/v4",
      control: undefined,
    },
    {
      provider: "zhipu",
      id: "glm-5.3-flash",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      control: undefined,
    },
    {
      provider: "custom",
      id: "deepseek-model",
      baseUrl: "https://api.deepseek.com",
      control: { thinking: { type: "disabled" } },
    },
    {
      provider: "custom",
      id: "together-model",
      baseUrl: "https://api.together.ai/v1",
      control: { reasoning: { enabled: false } },
    },
    {
      provider: "custom",
      id: "qwen-model",
      baseUrl: "https://proxy.example.com/v1",
      compat: { thinkingFormat: "qwen" as const },
      control: { enable_thinking: false },
    },
    {
      provider: "vllm",
      id: "qwen-chat-template-model",
      baseUrl: "http://localhost:8000/v1",
      compat: { thinkingFormat: "qwen-chat-template" as const },
      control: { chat_template_kwargs: { enable_thinking: false } },
    },
  ])("preserves the off contract for $id at $baseUrl", async ({ control, ...route }) => {
    const requests: Record<string, unknown>[] = [];
    const model: Model = {
      ...route,
      name: "Custom model",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    };
    await withServer(
      (request, response) => {
        void readText(request).then((raw) => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          requests.push(body);
          if (
            control === undefined &&
            (body.thinking ||
              body.enable_thinking !== undefined ||
              body.reasoning_effort === "none")
          ) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: {
                  code: "1210",
                  message: "This model always engages in thinking and cannot be disabled",
                },
              }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              id: "custom-title",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Custom provider title" },
                  finish_reason: "stop",
                },
              ],
            })}\n\ndata: [DONE]\n\n`,
          );
        });
      },
      async (serverUrl) => {
        const host = getAiTransportHost();
        configureAiTransportHost({
          ...host,
          // Replace only network I/O; retain endpoint inference and the title's execution path.
          buildModelFetch: () => async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            expect(url).toBe(`${route.baseUrl}/chat/completions`);
            return await fetch(`${serverUrl}/chat/completions`, init);
          },
        });
        try {
          const result = await completeWithPreparedSimpleCompletionModel({
            model,
            auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
            cfg: { plugins: { enabled: false } },
            context: {
              messages: [
                { role: "user", content: "Generate a short session title.", timestamp: 1 },
              ],
            },
            options: { reasoning: "off", maxTokens: 4096, strictReasoningTags: true },
          });
          expect(requests).toHaveLength(1);
          const body = requests[0];
          assert(body);
          expect(body).toMatchObject({ model: model.id, stream: true });
          expect(body.max_tokens ?? body.max_completion_tokens).toBe(4096);
          if (control) {
            expect(body).toMatchObject(control);
          } else {
            for (const field of [
              "thinking",
              "enable_thinking",
              "chat_template_kwargs",
              "reasoning_effort",
            ]) {
              expect(body).not.toHaveProperty(field);
            }
          }
          expect(result.stopReason).toBe("stop");
          expect(result.content).toContainEqual({ type: "text", text: "Custom provider title" });
        } finally {
          configureAiTransportHost(host);
        }
      },
    );
  });
});
