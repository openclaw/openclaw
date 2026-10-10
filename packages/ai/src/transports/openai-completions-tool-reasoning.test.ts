import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

let finishReason = "length";
let baseUrl = "";
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const deltas = [
      { content: "<think>Unfinished private reasoning" },
      {
        tool_calls: [
          {
            index: 0,
            id: "call_lookup",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"example"}' },
          },
        ],
      },
      {},
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [index, delta] of deltas.entries()) {
      response.write(
        `data: ${JSON.stringify({
          id: "completion_tool_reasoning",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: index === 2 ? finishReason : null }],
        })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback provider address");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

it.each([
  ["managed", "length"],
  ["direct", "length"],
  ["managed", "content_filter"],
  ["direct", "content_filter"],
] as const)("keeps unfinished reasoning private before tools (%s, %s)", async (mode, terminal) => {
  finishReason = terminal;
  const stream = await (
    mode === "managed" ? createOpenAICompletionsTransportStreamFn() : streamSimpleOpenAICompletions
  )(
    makeCompletionsModel({ baseUrl, reasoning: false }),
    { messages: [{ role: "user", content: "Look up the example.", timestamp: 1 }] },
    { apiKey: randomUUID() },
  );
  const visibleDeltas: string[] = [];
  for await (const event of stream) {
    if (event.type === "text_delta") {
      visibleDeltas.push(event.delta);
    }
  }
  const result = await stream.result();
  expect(visibleDeltas.join("")).toBe("");
  expect(result.content.filter((block) => block.type === "text")).toEqual([]);
});
