import { text as readText } from "node:stream/consumers";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";

describe("custom always-thinking simple completions", () => {
  it.each(["https://api.z.ai/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"])(
    "leaves undeclared thinking controls to the provider at %s",
    async (baseUrl) => {
      const requests: Record<string, unknown>[] = [];
      const model: Model = {
        provider: "zhipu",
        id: "glm-5.3-flash",
        name: "GLM",
        baseUrl,
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
              body.thinking ||
              body.enable_thinking !== undefined ||
              body.reasoning_effort === "none"
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
          await import("./ai-transport-runtime-host.js");
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
            expect(requests[0]).toMatchObject({ model: model.id, stream: true, max_tokens: 4096 });
            for (const field of [
              "thinking",
              "enable_thinking",
              "chat_template_kwargs",
              "reasoning_effort",
            ]) {
              expect(requests[0]).not.toHaveProperty(field);
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
});
