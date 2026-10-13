import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../../runtime/index.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { installMessageToolTerminalHook } from "./message-tool-terminal.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

describe("confirmed message-tool turn completion", () => {
  it.each([
    { final: true, hookThrows: false },
    { final: false, hookThrows: false },
    { final: true, hookThrows: true },
  ])(
    "settles sibling tools and only continues progress (final=$final, hookThrows=$hookThrows)",
    async ({ final, hookThrows }) => {
      let requests = 0;
      let deliveries = 0;
      const executed: string[] = [];
      const agent = new Agent({
        initialState: {
          model,
          tools: [
            {
              name: "message",
              label: "Message",
              description: "Reply to the current source",
              parameters: Type.Object({ action: Type.String(), final: Type.Boolean() }),
              execute: async () => {
                executed.push("message");
                return {
                  content: [],
                  details: {
                    messageDelivery: {
                      status: "settled",
                      partialDelivery: false,
                      createdThreadIds: [],
                      ...(final ? { sourceReplyDelivered: true } : {}),
                    },
                    sourceReplyRoute: "current-source",
                  },
                };
              },
            },
            {
              name: "lookup",
              label: "Lookup",
              description: "Read a value",
              parameters: Type.Object({}),
              execute: async () => {
                executed.push("lookup");
                return { content: [], details: { value: 42 } };
              },
            },
          ],
        },
        streamFn: () => {
          requests += 1;
          const content: AssistantMessage["content"] =
            requests === 1
              ? [
                  {
                    type: "toolCall",
                    id: "source-reply",
                    name: "message",
                    arguments: { action: "send", final },
                  },
                  { type: "toolCall", id: "lookup", name: "lookup", arguments: {} },
                ]
              : [{ type: "text", text: "Another visible answer." }];
          const stopReason = requests === 1 ? "toolUse" : "stop";
          const message: AssistantMessage = {
            role: "assistant",
            content,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason,
            timestamp: 0,
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "done", reason: stopReason, message });
            stream.end();
          });
          return stream;
        },
      });
      agent.afterToolCall = async (context) => {
        if (hookThrows && context.toolCall.name === "message") {
          context.result.details = { redacted: true };
          context.args = { action: "send", final: false };
          throw new Error("Presentation hook failed");
        }
        return undefined;
      };
      installMessageToolTerminalHook({
        agent,
        sourceReplyDeliveryMode: "automatic",
        onDeliveredSourceReply: () => {
          deliveries += 1;
        },
      });

      await agent.prompt("Answer with a source reply.");

      expect(executed).toEqual(["message", "lookup"]);
      expect(deliveries).toBe(1);
      expect(requests).toBe(final ? 1 : 2);
      expect(
        agent.state.messages.some(
          (message) =>
            message.role === "assistant" && message.content.some((block) => block.type === "text"),
        ),
      ).toBe(!final);
      expect(
        agent.state.messages.some((message) => message.role === "toolResult" && message.isError),
      ).toBe(hookThrows);
    },
  );
});
