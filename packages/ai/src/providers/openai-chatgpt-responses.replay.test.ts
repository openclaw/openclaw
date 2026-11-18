import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import type { Context } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";
import {
  createLoopbackModel,
  closeServer,
  chatgptContext as simpleContext,
  completedResponse as completion,
} from "./openai-chatgpt-responses.test-helpers.js";

type RecordedRequest = Record<string, unknown>;

const apiKey = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
).toString("base64url")}.synthetic-signature`;
const readOutput = {
  type: "function_call_output",
  call_id: "call_replay",
  output: "completed read result",
};

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
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        socket.on("message", (raw: Buffer) => {
          const request = JSON.parse(raw.toString()) as RecordedRequest;
          requests.push(request);
          if (requests.length === 1) {
            send({ type: "response.output_item.added", output_index: 0, item: reasoning });
            send({ type: "response.output_item.done", output_index: 0, item: reasoning });
            const event = completion("resp_tool");
            send({ ...event, response: { ...event.response, output: [reasoning, toolCall] } });
          } else if (request.previous_response_id || scenario === "reject-full") {
            if (scenario === "already-started") {
              send({ type: "response.created", response: { id: "resp_started" } });
            }
            send({
              type: "error",
              error: {
                message: scenario === "unrelated" ? "unrelated provider rejection" : rejection,
              },
            });
          } else {
            send(completion("resp_final"));
          }
        });
      });
      await once(server, "listening");
      const loopbackModel = createLoopbackModel(server);
      const options = { apiKey, sessionId: "tool-replay", transport: "auto" as const };
      try {
        const run = (context: Context) =>
          streamOpenAICodexResponses(loopbackModel, context, options).result();
        const first = await run(simpleContext);
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
            makeTextToolResult(call.id, call.name, "completed read result", false, 2),
          ],
        };
        const result = await run(context);
        expect(result.stopReason).toBe(scenario === "recover" ? "stop" : "error");
        expect(requests[1]).toMatchObject({
          previous_response_id: "resp_tool",
          input: [readOutput],
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
            expect.objectContaining(readOutput),
          ]);
        }
        if (scenario === "reject-full" || scenario === "already-started") {
          expect(result.errorMessage).toContain(rejection);
        }
      } finally {
        closeOpenAICodexWebSocketSessions(options.sessionId);
        await closeServer(server, server.clients);
      }
    },
  );
});
