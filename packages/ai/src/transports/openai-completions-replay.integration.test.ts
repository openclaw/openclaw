import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

describe("streamed Chat Completions reasoning replay on the wire", () => {
  let fixture: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
  let reasoningField: string;
  let requests: Array<{ messages: Array<Record<string, unknown>> }>;

  beforeAll(async () => {
    fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            requests.push(JSON.parse(body));
            const chunks =
              requests.length === 1
                ? [
                    makeCompletionsChunk({ [reasoningField]: "Check the forecast." }),
                    makeCompletionsChunk(
                      {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_weather",
                            type: "function",
                            function: { name: "weather", arguments: "{}" },
                          },
                        ],
                      },
                      "tool_calls",
                    ),
                  ]
                : [makeCompletionsChunk({ content: "Sunny." }, "stop")];
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
                "data: [DONE]\n\n",
            );
          });
        }),
    });
  });

  afterAll(async () => {
    fixture.listener.closeAllConnections();
    await fixture.releaseListener();
    await fixture.claim.release();
  });

  describe.each(["managed", "direct"] as const)("%s", (mode) => {
    it.each([
      {
        name: "explicit compat",
        field: "reasoning",
        required: true,
        expected: "reasoning_content",
      },
      {
        name: "explicit compat with reasoning_text",
        field: "reasoning_text",
        required: true,
        expected: "reasoning_content",
      },
      { name: "reasoning metadata", field: "reasoning", expected: "reasoning" },
      { name: "reasoning_text alias", field: "reasoning_text", expected: "reasoning_text" },
      {
        name: "native reasoning_content",
        field: "reasoning_content",
        expected: "reasoning_content",
      },
      { name: "stock OpenAI", field: "reasoning", provider: "openai" },
      { name: "model switch", field: "reasoning", switchModel: true },
      {
        name: "opencode-go rename",
        field: "reasoning",
        provider: "opencode-go",
        expected: "reasoning_content",
      },
    ])("$name", async ({ field, required, expected, provider, switchModel }) => {
      reasoningField = field;
      requests = [];
      const model = makeCompletionsModel({
        provider: provider ?? "custom-reasoning",
        baseUrl: `http://127.0.0.1:${fixture.claim.port}/v1`,
        ...(required ? { compat: { requiresReasoningContentOnAssistantMessages: true } } : {}),
      });
      const context: Context = {
        messages: [{ role: "user", content: "What is the weather?", timestamp: 1 }],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        ],
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
      context.messages.push(first, {
        role: "toolResult",
        toolCallId: "call_weather",
        toolName: "weather",
        content: [{ type: "text", text: "sunny" }],
        isError: false,
        timestamp: 2,
      });
      const second = await (
        await stream(switchModel ? { ...model, id: "other-model" } : model, context, options)
      ).result();
      expect(second.stopReason).toBe("stop");
      expect(requests).toHaveLength(2);
      const assistant = requests[1]?.messages.find((message) => message.role === "assistant");
      expect(assistant).toBeDefined();
      for (const key of ["reasoning", "reasoning_text", "reasoning_content", "reasoning_details"]) {
        if (key === expected) {
          expect(assistant).toHaveProperty(key, "Check the forecast.");
        } else {
          expect(assistant).not.toHaveProperty(key);
        }
      }
    });
  });
});
