import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { normalizeOpenAIResponsesFunctionCallId } from "./openai-responses-tool-call-id-shape.js";

// Proxy backends can return noncanonical IDs; replay must restore their raw wire IDs.
class ScriptedResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly script: Array<(request: Record<string, unknown>) => string>;
  private server: Server | undefined;

  constructor(script: Array<(request: Record<string, unknown>) => string>) {
    this.script = script;
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const index = this.requests.length;
        this.requests.push(parsed);
        const frame = this.script[index];
        if (!frame) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: `no scripted response for request ${index}` } }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${frame(parsed)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: { allowPrivateNetwork?: boolean },
): TModel {
  return {
    ...model,
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request,
  };
}

const RAW_CALL_ID = "functions.gateway:0";
const RAW_ITEM_ID = "fc_tmp_kegospxl46";

function completedFrame(responseId: string, output: unknown[]): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

function toolCallCompletedFrame(responseId: string, colliding = false): string {
  const calls = colliding
    ? [
        { id: "fc_1", call_id: " x", name: "first" },
        { id: "fc_1", call_id: "x", name: "second" },
      ]
    : [{ id: RAW_ITEM_ID, call_id: RAW_CALL_ID, name: "gateway" }];
  return completedFrame(
    responseId,
    calls.map((call) =>
      Object.assign(call, {
        type: "function_call",
        status: "completed",
        arguments: "{}",
      }),
    ),
  );
}

function textCompletedFrame(responseId: string, content: string): string {
  return completedFrame(responseId, [
    {
      id: `msg_${responseId}`,
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
      role: "assistant",
    },
  ]);
}

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

function customEndpointModel(baseUrl: string): Model<"openai-responses"> {
  const model = {
    id: "scripted-model",
    name: "Scripted Model",
    api: "openai-responses",
    provider: "omniroute",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: { supportsResponsesContinuation: true },
  } satisfies Model<"openai-responses">;
  return attachModelProviderRequestTransport(model, { allowPrivateNetwork: true });
}

async function run(
  model: Model<"openai-responses">,
  context: Context,
  sessionId: string,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: "test-key",
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  return stream.result();
}

describe("HTTP continuation across a non-canonical replayed tool-call id (loopback server, no SDK mocking)", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it("reshapes, matches, and restores a raw non-canonical call_id/id pair on continuation", async () => {
    const server = new ScriptedResponsesServer([
      () => toolCallCompletedFrame("resp_1"),
      () => textCompletedFrame("resp_2", "recorded"),
    ]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      const sessionId = "real-sse-noncanonical-id";
      const firstUser = userMessage("call the gateway tool", 1);
      const callTurn = await run(model, { messages: [firstUser], tools: [] }, sessionId);

      const toolCall = callTurn.content.find((block) => block.type === "toolCall") as
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
        | undefined;
      if (!toolCall) {
        throw new Error("Expected a completed tool call");
      }
      expect(toolCall.id).toBe(`${RAW_CALL_ID}|${RAW_ITEM_ID}`);

      // Match the agent's transcript normalization without importing its wrapper.
      const reshapedId = normalizeOpenAIResponsesFunctionCallId(toolCall.id);
      expect(reshapedId).not.toBe(toolCall.id);
      expect(reshapedId.endsWith(`|${RAW_ITEM_ID}`)).toBe(true);
      const reshapedToolCall = { ...callTurn, content: [{ ...toolCall, id: reshapedId }] };

      const toolResultMsg = {
        role: "toolResult" as const,
        toolCallId: reshapedId,
        toolName: "gateway",
        isError: false,
        content: [{ type: "text" as const, text: "recorded" }],
        timestamp: 2,
      };
      const round1Messages: Context["messages"] = [firstUser, reshapedToolCall, toolResultMsg];
      const afterToolResult = await run(model, { messages: round1Messages, tools: [] }, sessionId);
      expect(afterToolResult.stopReason).toBe("stop");

      expect(server.requests).toHaveLength(2);
      const secondRequest = server.requests[1];
      expect(secondRequest).toHaveProperty("previous_response_id", "resp_1");
      expect(secondRequest?.input).toEqual([
        {
          type: "function_call_output",
          call_id: RAW_CALL_ID,
          output: "recorded",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("resends full history when distinct cached calls share a replay ID shape", async () => {
    const server = new ScriptedResponsesServer([
      () => toolCallCompletedFrame("resp_1", true),
      () => textCompletedFrame("resp_2", "recorded"),
    ]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      const sessionId = "real-sse-ambiguous-noncanonical-ids";
      const firstUser = userMessage("call both tools", 1);
      const callTurn = await run(model, { messages: [firstUser], tools: [] }, sessionId);
      const toolCalls = callTurn.content.filter((block) => block.type === "toolCall") as Array<{
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;

      expect(toolCalls).toHaveLength(2);
      const replayedToolCalls = toolCalls.map((toolCall) =>
        Object.assign({}, toolCall, {
          id: normalizeOpenAIResponsesFunctionCallId(toolCall.id),
        }),
      );
      expect(replayedToolCalls[0]?.id).toBe(replayedToolCalls[1]?.id);
      const toolResults = replayedToolCalls.map((toolCall, index) => ({
        role: "toolResult" as const,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: false,
        content: [{ type: "text" as const, text: `result ${index + 1}` }],
        timestamp: index + 2,
      }));
      const messages: Context["messages"] = [
        firstUser,
        { ...callTurn, content: replayedToolCalls },
        ...toolResults,
      ];
      const afterToolResults = await run(model, { messages, tools: [] }, sessionId);

      expect(afterToolResults.stopReason).toBe("stop");
      expect(server.requests).toHaveLength(2);
      const secondRequest = server.requests[1];
      expect(secondRequest).not.toHaveProperty("previous_response_id");
      const input = secondRequest?.input as Array<Record<string, unknown>>;
      expect(input.some((item) => item.type === "function_call")).toBe(true);
      expect(input.some((item) => item.type === "function_call_output")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("stores and advances only new messages across three real chained turns", async () => {
    const questions = ["first question", "second question", "third question"];
    const server = new ScriptedResponsesServer(
      questions.map(
        (_, index) => () => textCompletedFrame(`resp_${index + 1}`, `answer ${index + 1}`),
      ),
    );
    const model = customEndpointModel(await server.listen());
    try {
      const context: Context = { messages: [], tools: [] };
      for (const [index, content] of questions.entries()) {
        context.messages.push({ role: "user", content, timestamp: index + 1 });
        const options = {
          apiKey: "test-key",
          sessionId: "real-sse-store-policy",
          transport: "sse",
          reasoningEffort: "low",
        } satisfies OpenAIResponsesOptions;
        const stream = await createOpenAIResponsesTransportStreamFn()(model, context, options);
        context.messages.push(await stream.result());
      }
      const { requests } = server;
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => request.store)).toEqual([true, true, true]);
      expect(requests[0]).not.toHaveProperty("previous_response_id");
      expect(requests[1]).toMatchObject({ previous_response_id: "resp_1" });
      expect(requests[2]).toMatchObject({ previous_response_id: "resp_2" });
      expect(requests.slice(1).map((request) => request.input)).toEqual(
        ["second question", "third question"].map((text) => [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ]),
      );
    } finally {
      await server.close();
    }
  });
});
