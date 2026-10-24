import { text as readText } from "node:stream/consumers";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { assert, expect, it } from "vitest";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import "./ai-transport-runtime-host.js";
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const successResponse =
  'data: {"id":"custom-title","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Custom provider title"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const thinkingError =
  '{"error":{"code":"1210","message":"This model always engages in thinking and cannot be disabled"}}';
const deepseekOff = { thinking: { type: "disabled" } };
const togetherOff = { reasoning: { enabled: false } };
const templateOff = { chat_template_kwargs: { enable_thinking: false } };

it.each([
  ["https://api.z.ai/api/paas/v4", "glm-5.3-flash", "zhipu", undefined, undefined],
  ["https://open.bigmodel.cn/api/paas/v4", "glm-5.3-flash", "zhipu", undefined, undefined],
  ["https://api.deepseek.com", "deepseek-model", "custom", deepseekOff, undefined],
  ["https://api.together.ai/v1", "together-model", "custom", togetherOff, undefined],
  ["https://proxy.example.com/v1", "qwen-model", "custom", { enable_thinking: false }, "qwen"],
  [
    "http://localhost:8000/v1",
    "qwen-chat-template-model",
    "vllm",
    templateOff,
    "qwen-chat-template",
  ],
] as const)(
  "preserves the off contract at %s",
  async (baseUrl, id, provider, control, thinkingFormat) => {
    const requests: Record<string, unknown>[] = [];
    const model = makeProviderModelFixture({
      baseUrl,
      id,
      provider,
      ...(thinkingFormat ? { compat: { thinkingFormat } } : {}),
      api: "openai-completions",
      reasoning: true,
    });
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
            response.end(thinkingError);
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(successResponse);
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
            expect(url).toBe(`${baseUrl}/chat/completions`);
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
  },
);
