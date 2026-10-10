import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;
const simpleContext: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
type RecordedRequest = Record<string, unknown>;

function createJwt(): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
    }),
  ).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.synthetic-signature`;
}

function completion(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

describe("ChatGPT Responses rejected continuation", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
  });
  it.each(["recover", "reject-full", "already-started", "unrelated"] as const)(
    "preserves completed tool results when cached continuation is rejected: %s",
    async (scenario) => {
      const rejection =
        "Persisted response contains hosted-tool, compaction, or unverifiable hidden reasoning state that Rustponses cannot replay. Start a new response or use the Python Responses service for this continuation.";
      const toolCall = {
        type: "function_call",
        id: "fc_replay",
        call_id: "call_replay",
        name: "read",
        arguments: '{"path":"fixture.txt"}',
        status: "completed",
      };
      const reasoning = {
        type: "reasoning",
        id: "rs_replay",
        encrypted_content: "opaque-reasoning",
        summary: [],
      };
      const requests: RecordedRequest[] = [];
      vi.stubGlobal("WebSocket", WebSocket);
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (socket) => {
        socket.on("message", (raw: Buffer) => {
          const request = JSON.parse(raw.toString()) as RecordedRequest;
          requests.push(request);
          if (requests.length === 1) {
            socket.send(
              JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: reasoning,
              }),
            );
            socket.send(
              JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item: reasoning,
              }),
            );
            const event = completion("resp_tool");
            socket.send(
              JSON.stringify({
                ...event,
                response: { ...event.response, output: [reasoning, toolCall] },
              }),
            );
          } else if (request.previous_response_id || scenario === "reject-full") {
            if (scenario === "already-started") {
              socket.send(
                JSON.stringify({ type: "response.created", response: { id: "resp_started" } }),
              );
            }
            socket.send(
              JSON.stringify({
                type: "error",
                error: {
                  message: scenario === "unrelated" ? "unrelated provider rejection" : rejection,
                },
              }),
            );
          } else {
            socket.send(JSON.stringify(completion("resp_final")));
          }
        });
      });
      await once(server, "listening");
      const loopbackModel = {
        ...model,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
      };
      const options = { apiKey: createJwt(), sessionId: "tool-replay", transport: "auto" as const };
      try {
        const first = await streamOpenAICodexResponses(
          loopbackModel,
          simpleContext,
          options,
        ).result();
        expect(first.stopReason).toBe("toolUse");
        const call = first.content.find((block) => block.type === "toolCall");
        expect(call).toMatchObject({ name: "read", arguments: { path: "fixture.txt" } });
        if (!call || call.type !== "toolCall") {
          throw new Error("missing tool call");
        }
        const context: Context = {
          messages: [
            ...simpleContext.messages,
            first,
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "completed read result" }],
              isError: false,
              timestamp: 2,
            },
          ],
        };
        const result = await streamOpenAICodexResponses(loopbackModel, context, options).result();
        expect(result.stopReason).toBe(scenario === "recover" ? "stop" : "error");
        expect(requests[1]).toMatchObject({
          previous_response_id: "resp_tool",
          input: [
            {
              type: "function_call_output",
              call_id: "call_replay",
              output: "completed read result",
            },
          ],
        });
        expect(requests).toHaveLength(scenario === "recover" || scenario === "reject-full" ? 3 : 2);
        if (requests[2]) {
          expect(requests[2].previous_response_id).toBeUndefined();
          expect(requests[2].input).toEqual([
            ...((requests[0]?.input ?? []) as unknown[]),
            expect.objectContaining({
              type: "reasoning",
              encrypted_content: reasoning.encrypted_content,
            }),
            expect.objectContaining({
              type: "function_call",
              call_id: toolCall.call_id,
              arguments: toolCall.arguments,
            }),
            expect.objectContaining({
              type: "function_call_output",
              call_id: toolCall.call_id,
              output: "completed read result",
            }),
          ]);
        }
        if (scenario === "reject-full" || scenario === "already-started") {
          expect(result.errorMessage).toContain(rejection);
        }
      } finally {
        closeOpenAICodexWebSocketSessions(options.sessionId);
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
