import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { runAgentLoop } from "./agent-loop.js";
import type { Message, Model } from "./llm.js";
import type { AgentEvent } from "./types.js";

// End-to-end regression for the partial-snapshot aliasing defect, through the
// real consumer: runAgentLoop drives the real openai-responses transport over
// a local SSE server, and the agent loop consumes the stream with its
// replace-or-append contract. Before the transport detached text snapshots,
// every message's first text delta was applied twice in the live
// message_update projection (the closing snapshot healed the stored message,
// so the doubling was transient and easy to miss). Text blocks are the only
// blocks at risk — agent-core appends only text_delta; every other delta kind
// carries its own partial and is replaced wholesale.

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";
const DELTAS = ["夜班巡检记录：", "雾笛、备用灯与无", "线电均正常。"];

function sse(events: readonly unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function providerEvents(): unknown[] {
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
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
      item_id: "msg_1",
      content_index: 0,
      text: WIRE_TEXT,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        status: "completed",
        content: [{ type: "output_text", text: WIRE_TEXT }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        end_turn: true,
        output: [
          {
            type: "message",
            id: "msg_1",
            status: "completed",
            content: [{ type: "output_text", text: WIRE_TEXT }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
      },
    },
  ];
}

async function startResponsesServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(providerEvents()));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

function messageUpdateTexts(events: readonly AgentEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "message_update" || !("content" in event.message)) {
      continue;
    }
    const blocks = typeof event.message.content === "string" ? [] : event.message.content;
    for (const block of blocks) {
      if (block.type === "text" && block.text.length > 0) {
        texts.push(block.text);
      }
    }
  }
  return texts;
}

describe("agent loop over openai-responses partial snapshots", () => {
  it("live message updates grow strictly, never doubling the opening", async () => {
    const { server, port } = await startResponsesServer();
    try {
      const model: Model<"openai-responses"> = {
        id: "test-model",
        name: "Test model",
        provider: "volcengine-plan",
        api: "openai-responses",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      };
      const events: AgentEvent[] = [];
      const result = await runAgentLoop(
        [{ role: "user", content: "Report the night watch log.", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [] },
        {
          model,
          convertToLlm: (messages) => messages as Message[],
        },
        (event) => {
          events.push(event);
        },
        undefined,
        (_loopModel, context, options) =>
          streamOpenAIResponses(model, context, { ...options, apiKey: "test-key" }),
      );

      // Every live update must be a strict prefix of the wire text — a
      // doubled opening surfaces here as text that is NOT a wire prefix.
      const updates = messageUpdateTexts(events);
      expect(updates.length).toBeGreaterThan(0);
      for (const text of updates) {
        expect(WIRE_TEXT.startsWith(text)).toBe(true);
      }
      // Monotonic growth: each update extends the previous one.
      for (const [index, text] of updates.entries()) {
        if (index === 0) {
          continue;
        }
        const previous = updates[index - 1] ?? "";
        expect(text.startsWith(previous)).toBe(true);
      }
      // The final live update must carry the complete wire text exactly once.
      expect(updates.at(-1)).toBe(WIRE_TEXT);
      void result;
    } finally {
      server.close();
    }
  });
});
