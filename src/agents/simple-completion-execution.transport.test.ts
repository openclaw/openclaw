import { text as readText } from "node:stream/consumers";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { assert, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
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
const anthropicResponse =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","usage":{"input_tokens":40,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Custom provider title"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

it.each([
  ["https://provider.invalid", "synthetic-model", "anthropic", undefined, undefined],
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
  "preserves the off contract and serializes once with exact wire bytes at %s",
  async (baseUrl, id, provider, control, thinkingFormat) => {
    const requests: Record<string, unknown>[] = [];
    let wire = "";
    const model = makeProviderModelFixture({
      baseUrl,
      id,
      provider,
      ...(thinkingFormat ? { compat: { thinkingFormat } } : {}),
      api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
      reasoning: provider !== "anthropic",
    });
    await withServer(
      (request, response) => {
        void readText(request).then((raw) => {
          wire = raw;
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
          response.end(provider === "anthropic" ? anthropicResponse : successResponse);
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
            expect(url).toBe(
              `${baseUrl}/${provider === "anthropic" ? "v1/messages" : "chat/completions"}`,
            );
            return await fetch(`${serverUrl}/chat/completions`, init);
          },
        });
        const events: DiagnosticEventPayload[] = [];
        setDiagnosticsEnabledForProcess(true);
        const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event));
        using stringify = vi.spyOn(JSON, "stringify");
        try {
          const result = await completeWithPreparedSimpleCompletionModel({
            model,
            auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
            cfg: { plugins: { enabled: false } },
            context: {
              messages: Array.from({ length: 40 }, (_, index) => ({
                role: "user" as const,
                content: `Message ${index}: " \\ \n 🦞\ud800`,
                timestamp: index,
              })),
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
          await waitForDiagnosticEventsDrained();
          expect(events.find((event) => event.type === "model.call.completed")).toMatchObject({
            requestPayloadBytes: Buffer.byteLength(wire, "utf8"),
          });
          expect(
            stringify.mock.calls.filter(([value]) => value?.model === id && value.messages),
          ).toHaveLength(1);
        } finally {
          stop();
          resetDiagnosticEventsForTest();
          configureAiTransportHost(host);
        }
      },
    );
  },
);
