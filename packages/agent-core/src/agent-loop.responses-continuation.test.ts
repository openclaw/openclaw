import { createServer } from "node:http";
import { expect, it } from "vitest";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "../../../test/helpers/openai-responses-sse.js";
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { captureAgentLoop, config, model as baseModel, user } from "./agent-loop.test-support.js";
import type { Model } from "./llm.js";
import type { AgentEvent } from "./types.js";

// Closing snapshots hide aliased text-delta doubling; inspect live updates through real SSE.

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";
const DELTAS = ["夜班巡检记录：", "雾笛、备用灯与无", "线电均正常。"];

function providerEvents(): Record<string, unknown>[] {
  const item = {
    type: "message",
    id: "msg_1",
    status: "completed",
    content: [{ type: "output_text", text: WIRE_TEXT }],
  };
  const textPart = { item_id: "msg_1", content_index: 0 };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      ...textPart,
      part: { type: "output_text", text: "" },
    },
    ...DELTAS.map((delta) => ({
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      ...textPart,
      text: WIRE_TEXT,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        end_turn: true,
        output: [item],
        usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
      },
    },
  ];
}

function messageUpdateTexts(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => {
    if (
      event.type !== "message_update" ||
      !("content" in event.message) ||
      typeof event.message.content === "string"
    ) {
      return [];
    }
    return event.message.content.flatMap((block) =>
      block.type === "text" && block.text.length > 0 ? [block.text] : [],
    );
  });
}

it("openai-responses live message updates grow strictly, never doubling the opening", async () => {
  const server = createServer((_req, res) => writeOpenAiResponsesSse(res, providerEvents()));
  const baseUrl = await listenLoopback(server);
  try {
    const model: Model<"openai-responses"> = {
      ...baseModel,
      name: "Test model",
      provider: "volcengine-plan",
      api: "openai-responses",
      baseUrl: `${baseUrl}/v1`,
      contextWindow: 8192,
      maxTokens: 256,
    };
    const run = captureAgentLoop(
      [user("Report the night watch log.")],
      { systemPrompt: "", messages: [], tools: [] },
      { ...config, model },
      undefined,
      (_loopModel, context, options) =>
        streamOpenAIResponses(model, context, { ...options, apiKey: "test-key" }),
    );
    await run.result;

    const updates = messageUpdateTexts(run.events);
    expect(updates.length).toBeGreaterThan(0);
    for (const [index, text] of updates.entries()) {
      expect(WIRE_TEXT.startsWith(text)).toBe(true);
      if (index > 0) {
        expect(text.startsWith(updates[index - 1] ?? "")).toBe(true);
      }
    }
    expect(updates.at(-1)).toBe(WIRE_TEXT);
  } finally {
    server.close();
  }
});
