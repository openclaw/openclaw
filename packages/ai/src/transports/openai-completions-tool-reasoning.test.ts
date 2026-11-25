import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../../test/helpers/gateway-integration-fixtures.js";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsModel,
  makeCompletionsToolDelta,
} from "./openai-completions.test-support.js";

let finishReason = "length";
let baseUrl = "";
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const deltas = [
      { content: "<think>Unfinished private reasoning" },
      makeCompletionsToolDelta("call_lookup", "lookup", '{"query":"example"}'),
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
  baseUrl = `${await listenLoopback(server)}/v1`;
});

afterAll(async () => {
  await closeHttpServer(server);
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
