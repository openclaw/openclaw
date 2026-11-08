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
      assert(["/v1/messages", "/v1/responses", "/v1/chat/completions"].includes(request.url ?? ""));
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= 64 * 1024, "cache fixture request exceeded its byte bound");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(typeof payload.model, "string");
      assert.equal(payload.stream, true);
      assert(Array.isArray(payload.messages ?? payload.input));
      const stage = requests % 4;
      requests += 1;
      assert(requests <= 16, "cache fixture received an extra request");
      const toolUse = stage < 2;
      const anthropicEvents = [
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
      const events =
        request.url === "/v1/messages"
          ? anthropicEvents
          : request.url === "/v1/responses"
            ? responsesEvents(requests, stage)
            : completionsEvents(requests, stage, payload.model);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map(
            (event) =>
              `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          )
          .join("") + (request.url === "/v1/messages" ? "" : "data: [DONE]\n\n"),
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
    assertComplete(expectedRequests = 8) {
      assert.equal(
        requests,
        expectedRequests,
        `expected ${expectedRequests} installed-builder HTTP requests`,
      );
    },
  };
}

function responsesEvents(request: number, stage: number) {
  const toolUse = stage < 2;
  const item = toolUse
    ? {
        type: "function_call",
        id: `fc_${request}`,
        call_id: `call_${request}`,
        name: "cache_probe",
        arguments: JSON.stringify({ step: stage + 1 }),
      }
    : {
        type: "message",
        id: `msg_${request}`,
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: stage === 2 ? "CACHE-OK" : "NEXT-OK", annotations: [] },
        ],
      };
  return [
    {
      type: "response.created",
      response: { id: `resp_${request}`, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: toolUse ? { ...item, arguments: "" } : { ...item, content: [] },
    },
    ...(toolUse
      ? [
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: item.arguments,
          },
        ]
      : [
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: stage === 2 ? "CACHE-OK" : "NEXT-OK",
          },
        ]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${request}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 6_000 + stage * 400,
          output_tokens: 16,
          input_tokens_details: { cached_tokens: stage === 0 ? 0 : 6_000 + (stage - 1) * 400 },
        },
      },
    },
  ];
}

function completionsEvents(request: number, stage: number, model: string) {
  const toolUse = stage < 2;
  return [
    {
      id: `chatcmpl-${request}`,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: toolUse
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${request}`,
                    type: "function",
                    function: {
                      name: "cache_probe",
                      arguments: JSON.stringify({ step: stage + 1 }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: stage === 2 ? "CACHE-OK" : "NEXT-OK" },
          finish_reason: toolUse ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: 6_000 + stage * 400,
        completion_tokens: 16,
        total_tokens: 6_016 + stage * 400,
        prompt_tokens_details: { cached_tokens: stage === 0 ? 0 : 6_000 + (stage - 1) * 400 },
      },
    },
  ];
}
