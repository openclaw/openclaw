import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "../../../test/helpers/openai-responses-sse.js";
import { streamOpenAICodexResponses } from "../../ai/src/providers/openai-chatgpt-responses.js";
import {
  closeServer,
  completedResponse,
  createJwt,
} from "../../ai/src/providers/openai-chatgpt-responses.test-helpers.js";
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { makeProviderModel } from "../../ai/src/providers/provider-model.test-support.js";
import {
  captureAgentLoop,
  config,
  makeTool,
  model as baseModel,
  user,
} from "./agent-loop.test-support.js";
import type { Model } from "./llm.js";
import type { AgentEvent } from "./types.js";

function textItem(id: string, text: string) {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

it("Responses continues end_turn:false text through a tool result to the final answer", async () => {
  const requests: ResponseCreateParamsStreaming[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      requests.push(JSON.parse(rawDataToString(data)) as ResponseCreateParamsStreaming);
      const index = requests.length;
      const output =
        index === 2
          ? {
              type: "function_call",
              id: "fc_check",
              call_id: "call_check",
              name: "check",
              arguments: "{}",
              status: "completed",
            }
          : index === 1
            ? textItem("msg_progress", "I am checking the result.")
            : textItem("msg_final", "The check passed.");
      const event = completedResponse(`resp_${index}`);
      Object.assign(event.response, { end_turn: index === 3, output: [output] });
      socket.send(JSON.stringify(event));
    });
  });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const model = makeProviderModel("openai-chatgpt-responses", "openai", "test-model", {
    name: "Test model",
    baseUrl: `http://127.0.0.1:${port}/backend-api`,
    contextWindow: 8192,
    maxTokens: 256,
  });
  const apiKey = createJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-loopback" },
  });
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "checked" }],
    details: {},
  }));
  try {
    const run = captureAgentLoop(
      [user("Check the result and report it.")],
      { systemPrompt: "", messages: [], tools: [{ ...makeTool("check"), execute }] },
      { ...config, model },
      undefined,
      (_model, context, options) =>
        streamOpenAICodexResponses(model, context, {
          ...options,
          apiKey,
          transport: "websocket",
        }),
    );
    const result = await run.result;
    expect(requests).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    const assistants = result
      .filter((message) => message.role === "assistant")
      .filter((message) => message.responseId !== undefined);
    expect(assistants).toHaveLength(3);
    for (const [index, assistant] of assistants.entries()) {
      expect(assistant.diagnostics).toEqual([
        {
          type: "openai_responses_terminal",
          timestamp: expect.any(Number),
          details: {
            eventType: "response.completed",
            stopReason: "stop",
            endTurn: index === 2,
          },
        },
      ]);
    }
    expect(JSON.stringify(requests)).not.toContain("openai_responses_terminal");
    expect(result.at(-1)).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ text: "The check passed." })],
    });
    const expectInput = (index: number, item: object) =>
      expect(requests[index]?.input).toEqual(
        expect.arrayContaining([expect.objectContaining(item)]),
      );
    expectInput(1, {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [expect.objectContaining({ text: "I am checking the result." })],
    });
    expectInput(2, { type: "function_call_output", call_id: "call_check", output: "checked" });
  } finally {
    await closeServer(server, server.clients);
  }
});

// Closing snapshots hide aliased text-delta doubling; inspect live updates through real SSE.

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";
const DELTAS = ["夜班巡检记录：", "雾笛、备用灯与无", "线电均正常。"];

function providerEvents(): Record<string, unknown>[] {
  const item = {
    type: "message",
    id: "msg_1",
    status: "completed",
    content: [{ type: "output_text", text: WIRE_TEXT }],
  };
  const textPart = { item_id: "msg_1", content_index: 0 };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      ...textPart,
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
      ...textPart,
      text: WIRE_TEXT,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        end_turn: true,
        output: [item],
        usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
      },
    },
  ];
}

function messageUpdateTexts(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => {
    if (
      event.type !== "message_update" ||
      !("content" in event.message) ||
      typeof event.message.content === "string"
    ) {
      return [];
    }
    return event.message.content.flatMap((block) =>
      block.type === "text" && block.text.length > 0 ? [block.text] : [],
    );
  });
}

it("openai-responses live message updates grow strictly, never doubling the opening", async () => {
  const server = createServer((_req, res) => writeOpenAiResponsesSse(res, providerEvents()));
  const baseUrl = await listenLoopback(server);
  try {
    const model: Model<"openai-responses"> = {
      ...baseModel,
      name: "Test model",
      provider: "volcengine-plan",
      api: "openai-responses",
      baseUrl: `${baseUrl}/v1`,
      contextWindow: 8192,
      maxTokens: 256,
    };
    const run = captureAgentLoop(
      [user("Report the night watch log.")],
      { systemPrompt: "", messages: [], tools: [] },
      { ...config, model },
      undefined,
      (_loopModel, context, options) =>
        streamOpenAIResponses(model, context, { ...options, apiKey: "test-key" }),
    );
    await run.result;

    const updates = messageUpdateTexts(run.events);
    expect(updates.length).toBeGreaterThan(0);
    for (const [index, text] of updates.entries()) {
      expect(WIRE_TEXT.startsWith(text)).toBe(true);
      if (index > 0) {
        expect(text.startsWith(updates[index - 1] ?? "")).toBe(true);
      }
    }
    expect(updates.at(-1)).toBe(WIRE_TEXT);
  } finally {
    server.close();
  }
});
