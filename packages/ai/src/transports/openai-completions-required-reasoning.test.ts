import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { collectStream } from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsChunk,
  makeCompletionsModel,
  makeCompletionsToolDelta,
} from "./openai-completions.test-support.js";

describe.each(["managed", "direct"] as const)("%s required reasoning replay", (mode) => {
  it.each([
    { id: "kimi-k3.1-pro", reasoning: true, effort: "off", preserve: true },
    { id: "kimi-k3.1-pro", reasoning: true, effort: "none", preserve: true },
    { id: "kimi-k3.1-pro", reasoning: false, effort: "off", preserve: true },
    { id: "custom-model", reasoning: true, effort: "off", required: true, preserve: true },
    { id: "custom-model", reasoning: true, effort: "off", preserve: false },
  ] as const)(
    "retains provider reasoning according to its replay contract: %j",
    async (testCase) => {
      const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
      const previousHost = getAiTransportHost();
      const fetchFixture: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(await request.json());
        const chunks =
          requests.length === 1
            ? [
                makeCompletionsChunk({ reasoning_content: "Check the forecast." }),
                makeCompletionsChunk(
                  makeCompletionsToolDelta("call_weather", "weather", "{}"),
                  "tool_calls",
                ),
              ]
            : [makeCompletionsChunk({ content: "Sunny." }, "stop")];
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      };
      configureAiTransportHost({ ...previousHost, buildModelFetch: () => fetchFixture });
      vi.stubGlobal("fetch", fetchFixture);
      try {
        const model = makeCompletionsModel({
          id: testCase.id,
          provider: "opencode-go",
          baseUrl: "https://provider.example/v1",
          reasoning: testCase.reasoning,
          ...("required" in testCase
            ? { compat: { requiresReasoningContentOnAssistantMessages: true } }
            : {}),
        });
        const context: Context = {
          messages: [{ role: "user", content: "What is the weather?", timestamp: 1 }],
          tools: [{ name: "weather", description: "", parameters: { type: "object" } }],
        };
        const stream =
          mode === "direct" ? streamOpenAICompletions : createOpenAICompletionsTransportStreamFn();
        const options = { apiKey: "synthetic-key", reasoningEffort: testCase.effort };
        const first = await collectStream(stream(model, context, options));
        expect(first.result.stopReason).toBe("toolUse");
        expect(first.thinking).toBe(testCase.preserve ? "Check the forecast." : "");
        expect(first.text).toBe("");
        context.messages.push(
          first.result,
          makeTextToolResult("call_weather", "weather", "sunny", false, 2),
        );
        const second = await collectStream(stream(model, context, options));
        expect(second.result.stopReason).toBe("stop");
        expect(second.text).toBe("Sunny.");
        expect(requests).toHaveLength(2);
        const assistant = requests[1]?.messages.find((message) => message.role === "assistant");
        expect(assistant).toBeDefined();
        if (testCase.preserve) {
          expect(assistant?.reasoning_content).toBe("Check the forecast.");
        } else {
          expect(assistant).not.toHaveProperty("reasoning_content");
        }
      } finally {
        configureAiTransportHost(previousHost);
        vi.unstubAllGlobals();
      }
    },
  );
});
