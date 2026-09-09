import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Secretless HTTP/SSE proof of the same installed builders used by the live lane. */
export async function startMockAnthropic() {
  let requests = 0;
  const server = createServer((request, response) => {
    void respond(request, response);
  });
  async function respond(request: IncomingMessage, response: ServerResponse) {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/messages");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= 64 * 1024, "cache fixture request exceeded its byte bound");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(payload.model, "claude-sonnet-4-6");
      assert.equal(payload.stream, true);
      assert(Array.isArray(payload.messages));
      const stage = requests % 4;
      requests += 1;
      assert(requests <= 8, "cache fixture received an extra request");
      const toolUse = stage < 2;
      const events = [
        {
          type: "message_start",
          message: {
            id: `cache-message-${requests}`,
            type: "message",
            role: "assistant",
            model: payload.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 20,
              output_tokens: 0,
              cache_creation_input_tokens: stage === 0 ? 6_000 : 400,
              cache_read_input_tokens: stage === 0 ? 0 : 6_000 + (stage - 1) * 400,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: toolUse
            ? { type: "tool_use", id: `cache-tool-${requests}`, name: "cache_probe", input: {} }
            : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: toolUse
            ? { type: "input_json_delta", partial_json: JSON.stringify({ step: stage + 1 }) }
            : { type: "text_delta", text: stage === 2 ? "CACHE-OK" : "NEXT-OK" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 16 },
        },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Invalid synthetic cache probe request",
          },
        }),
      );
    }
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
    assertComplete() {
      assert.equal(requests, 8, "expected eight installed-builder HTTP requests");
    },
  };
}
