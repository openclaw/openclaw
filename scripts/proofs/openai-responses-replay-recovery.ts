import assert from "node:assert/strict";
import http from "node:http";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createOpenAIResponsesTransportStreamFn } from "../../src/agents/openai-transport-stream.js";
import { wrapOpenAIResponsesStreamWithReplayRecovery } from "../../src/agents/pi-embedded-runner/thinking.js";

type RecordedRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildModel(baseUrl: string): Model<"openai-responses"> {
  return {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildReplayableAssistantMessage(): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    content: [
      {
        type: "thinking",
        thinking: "private reasoning",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_real_transport_proof",
          summary: [],
        }),
      },
      {
        type: "text",
        text: "visible answer",
        textSignature: JSON.stringify({
          v: 1,
          id: "msg_real_transport_proof",
          phase: "final_answer",
        }),
      },
    ],
  };
}

async function readRequestBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function writeSse(response: http.ServerResponse, events: unknown[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function writeReasoningReplayError(response: http.ServerResponse) {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        code: "thinking_signature_invalid",
        message:
          "The encrypted content for item rs_real_transport_proof could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
        type: "invalid_request_error",
      },
    }),
  );
}

function createProofServer(recordedRequests: RecordedRequest[]) {
  return http.createServer((request, response) => {
    void (async () => {
      try {
        const body = await readRequestBody(request);
        recordedRequests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body,
        });

        if (recordedRequests.length === 1) {
          writeReasoningReplayError(response);
          return;
        }

        writeSse(response, [
          { type: "response.created", response: { id: "resp_real_transport_recovered" } },
          {
            type: "response.output_item.added",
            item: {
              type: "message",
              id: "msg_real_transport_recovered",
              role: "assistant",
              content: [],
              status: "in_progress",
            },
          },
          { type: "response.output_text.delta", delta: "recovered via real http transport" },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              id: "msg_real_transport_recovered",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "recovered via real http transport" }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_real_transport_recovered",
              status: "completed",
              usage: {
                input_tokens: 2,
                output_tokens: 5,
                total_tokens: 7,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ]);
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : error }));
      }
    })();
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server) {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function inputItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : [];
}

function inputTypes(body: Record<string, unknown>): string[] {
  return inputItems(body)
    .map((item) => item.type)
    .filter((type): type is string => typeof type === "string");
}

function countInputType(body: Record<string, unknown>, type: string): number {
  return inputTypes(body).filter((itemType) => itemType === type).length;
}

async function main() {
  const recordedRequests: RecordedRequest[] = [];
  const server = createProofServer(recordedRequests);
  const port = await listen(server);
  try {
    const wrapped = wrapOpenAIResponsesStreamWithReplayRecovery(
      createOpenAIResponsesTransportStreamFn(),
      { id: "real-http-transport-proof-session" },
    );
    const stream = wrapped(
      buildModel(`http://127.0.0.1:${port}/v1`),
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "continue", timestamp: Date.now() },
          buildReplayableAssistantMessage(),
          { role: "user", content: "continue again", timestamp: Date.now() },
        ],
      } as never,
      { apiKey: "sk-redacted-real-http-proof" } as never,
    ) as { result: () => Promise<AgentMessage> };

    const result = await stream.result();
    const first = recordedRequests[0];
    const second = recordedRequests[1];
    assert.equal(recordedRequests.length, 2);
    assert(first);
    assert(second);
    assert.equal(first.method, "POST");
    assert.equal(second.method, "POST");
    assert.equal(first.path, "/v1/responses");
    assert.equal(second.path, "/v1/responses");
    assert(inputTypes(first.body).includes("reasoning"));
    assert(!inputTypes(second.body).includes("reasoning"));
    assert(countInputType(second.body, "message") >= 1);
    assert.equal(result.stopReason, "stop");
    const firstContent = result.content[0];
    assert(firstContent && firstContent.type === "text");
    assert.equal(firstContent.text, "recovered via real http transport");

    console.log("OpenAI Responses replay recovery proof: PASS");
    console.log("Runtime path: real OpenAI SDK HTTP transport against loopback /v1/responses");
    console.log(
      "Mocking: no vi.mock/openai SDK mock; loopback server returns provider-shaped HTTP/SSE",
    );
    console.log("Requests observed:", recordedRequests.length);
    console.log("Request paths:", recordedRequests.map((request) => request.path).join(", "));
    console.log("First response:", "HTTP 400 thinking_signature_invalid");
    console.log("First request input types:", inputTypes(first.body).join(", "));
    console.log("Retry request input types:", inputTypes(second.body).join(", "));
    console.log(
      "Retry dropped replayed reasoning:",
      !inputTypes(second.body).includes("reasoning"),
    );
    console.log("Retry preserved replayed message:", countInputType(second.body, "message") >= 1);
    console.log("Recovered assistant text:", firstContent.text);
    console.log("Final stopReason:", result.stopReason);
  } finally {
    await closeServer(server);
  }
}

void main().catch((error) => {
  console.error("OpenAI Responses replay recovery proof: FAIL");
  console.error(error);
  process.exitCode = 1;
});
