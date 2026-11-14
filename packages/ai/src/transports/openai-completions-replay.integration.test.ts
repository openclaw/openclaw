import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { startSse, withServer, writeSse } from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsChunk,
  makeCompletionsModel,
  makeCompletionsToolDelta,
} from "./openai-completions.test-support.js";

describe.each(["managed", "direct"] as const)("%s", (mode) => {
  it.each([
    { field: "reasoning", required: true, expected: "reasoning_content" },
    { field: "reasoning_text", required: true, expected: "reasoning_content" },
    { field: "reasoning", expected: "reasoning" },
    { field: "reasoning_text", expected: "reasoning_text" },
    { field: "reasoning_content", expected: "reasoning_content" },
    { field: "reasoning", provider: "openai" },
    { field: "reasoning", switchModel: true },
    { field: "reasoning", provider: "opencode-go", expected: "reasoning_content" },
  ])("replays reasoning with %j", async ({ field, required, expected, provider, switchModel }) => {
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    await withServer(
      (_request, response, body) => {
        requests.push(JSON.parse(body));
        const chunks =
          requests.length === 1
            ? [
                makeCompletionsChunk({ [field]: "Check the forecast." }),
                makeCompletionsChunk(
                  makeCompletionsToolDelta("call_weather", "weather", "{}"),
                  "tool_calls",
                ),
              ]
            : [makeCompletionsChunk({ content: "Sunny." }, "stop")];
        startSse(response);
        for (const chunk of chunks) {
          writeSse(response, chunk);
        }
        response.end("data: [DONE]\n\n");
      },
      async (baseUrl) => {
        const model = makeCompletionsModel({
          provider: provider ?? "custom-reasoning",
          baseUrl,
          ...(required ? { compat: { requiresReasoningContentOnAssistantMessages: true } } : {}),
        });
        const context: Context = {
          messages: [{ role: "user", content: "What is the weather?", timestamp: 1 }],
          tools: [{ name: "weather", description: "", parameters: { type: "object" } }],
        };
        const stream =
          mode === "direct" ? streamOpenAICompletions : createOpenAICompletionsTransportStreamFn();
        const options = { apiKey: "synthetic-key", reasoningEffort: "medium" as const };
        const first = await (await stream(model, context, options)).result();
        expect(first.stopReason).toBe("toolUse");
        expect(first.content).toContainEqual({
          type: "thinking",
          thinking: "Check the forecast.",
          thinkingSignature:
            provider === "opencode-go" && mode === "direct" ? "reasoning_content" : field,
        });
        context.messages.push(
          first,
          makeTextToolResult("call_weather", "weather", "sunny", false, 2),
        );
        const second = await (
          await stream(switchModel ? { ...model, id: "other-model" } : model, context, options)
        ).result();
        expect(second.stopReason).toBe("stop");
        expect(requests).toHaveLength(2);
        const assistant = requests[1]?.messages.find((message) => message.role === "assistant");
        expect(assistant).toBeDefined();
        const replayFields = new Set([
          "reasoning",
          "reasoning_text",
          "reasoning_content",
          "reasoning_details",
        ]);
        expect(
          Object.fromEntries(
            Object.entries(assistant ?? {}).filter(([key]) => replayFields.has(key)),
          ),
        ).toStrictEqual(expected ? { [expected]: "Check the forecast." } : {});
      },
    );
  });
});
