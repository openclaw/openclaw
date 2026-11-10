// Loopback-only synthetic Responses provider for the subscription invalidation workload.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.ts";
import { readBody, writeJson } from "../e2e/lib/mock-openai-http.mjs";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const port = parseStrictIntegerOption({
  raw: process.env.MOCK_PORT,
  label: "MOCK_PORT",
  min: 40000,
  fallback: 0,
});
assert(port <= 65535);
const label = process.env.MOCK_SPAWN_LABEL;
assert(label);
const text = "Synthetic task PR measurement complete. ".repeat(48).trim();
const counters = {
  requests: { ingress: { responses: 0 } },
  streamChunks: 0,
  streaming: 0,
  maxConcurrentStreams: 0,
  spawnCalls: 0,
};
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, counters);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      writeJson(response, 404, { error: "Synthetic Responses route only" });
      return;
    }
    const body: unknown = JSON.parse(await readBody(request));
    assert(isRecord(body));
    counters.requests.ingress.responses++;
    const messageId = `msg_${randomUUID()}`;
    const responseId = `resp_${randomUUID()}`;
    const message = {
      type: "message",
      id: messageId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const complete = (output: unknown[]) => ({
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output,
        usage: { input_tokens: 64, output_tokens: 64, total_tokens: 128 },
      },
    });
    if (body.stream === false) {
      writeJson(response, 200, { ...complete([message]).response, object: "response" });
      return;
    }
    if (
      counters.spawnCalls === 0 &&
      JSON.stringify(body.input ?? []).includes("SESSION_PR_SPAWN_ONCE")
    ) {
      const exposedTools = Array.isArray(body.tools)
        ? body.tools.filter(isRecord).map((tool) => String(tool.name ?? tool.type).slice(0, 80))
        : [];
      assert(
        exposedTools.includes("sessions_spawn"),
        `Mixed fixture must expose sessions_spawn; exposed tools: ${JSON.stringify(exposedTools.slice(0, 64))}`,
      );
      counters.spawnCalls++;
      const item = {
        type: "function_call",
        id: `fc_${randomUUID()}`,
        call_id: `call_${randomUUID()}`,
        name: "sessions_spawn",
        arguments: JSON.stringify({
          task: "Reply with the synthetic measurement text.",
          label,
          runtime: "subagent",
          mode: "run",
          context: "isolated",
          cleanup: "keep",
          expectsCompletionMessage: false,
        }),
      };
      writeOpenAiResponsesSse(response, [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: item.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item },
        complete([item]),
      ]);
      return;
    }
    counters.streaming++;
    counters.maxConcurrentStreams = Math.max(counters.maxConcurrentStreams, counters.streaming);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      });
      for (const delta of text.match(/.{1,40}/gu) ?? []) {
        await delay(25);
        if (response.destroyed) {
          return;
        }
        counters.streamChunks++;
        send({
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        });
      }
      send({
        type: "response.output_text.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      });
      send({ type: "response.output_item.done", output_index: 0, item: message });
      send(complete([message]));
      response.end("data: [DONE]\n\n");
    } finally {
      counters.streaming--;
    }
  })().catch((error: unknown) => {
    console.error(String(error));
    if (!response.headersSent) {
      writeJson(response, 500, { error: String(error) });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.log(`mock-openai listening on ${port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
