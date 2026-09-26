import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { streamOpenAICodexResponses } from "../../ai/src/providers/openai-chatgpt-responses.js";
import { runAgentLoop } from "./agent-loop.js";
import type { Message, Model } from "./llm.js";
import type { AgentEvent, AgentTool } from "./types.js";

function textItem(id: string, text: string, phase = "final_answer") {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

describe("Responses turn continuation", () => {
  it.each([
    { label: "explicit continuation with final text", endTurn: false, requests: 3 },
    {
      label: "explicit continuation with commentary",
      endTurn: false,
      phase: "commentary",
      requests: 3,
    },
    { label: "explicit end", endTurn: true, requests: 1 },
    { label: "omitted end_turn", endTurn: undefined, requests: 1 },
    { label: "malformed end_turn", endTurn: "false", requests: 1 },
    { label: "null end_turn", endTurn: null, requests: 1 },
    { label: "object end_turn", endTurn: { privateValue: "do not retain" }, requests: 1 },
    { label: "incomplete response", endTurn: false, incomplete: true, requests: 1 },
    { label: "caller cancellation", endTurn: false, cancel: true, requests: 1 },
    { label: "host stop decision", endTurn: false, stop: true, requests: 1 },
    { label: "intentional tool termination", endTurn: false, terminateTool: true, requests: 2 },
  ])("$label", async (scenario) => {
    const { endTurn } = scenario;
    const controller = new AbortController();
    const requests: ResponseCreateParamsStreaming[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        requests.push(JSON.parse(bytes.toString("utf8")) as ResponseCreateParamsStreaming);
        const index = requests.length;
        const output =
          index === 1
            ? [textItem("msg_progress", "I am checking the result.", scenario.phase)]
            : index === 2
              ? [
                  {
                    type: "function_call",
                    id: "fc_check",
                    call_id: "call_check",
                    name: "check",
                    arguments: "{}",
                    status: "completed",
                  },
                ]
              : [textItem("msg_final", "The check passed.")];
        socket.send(
          JSON.stringify({
            type: scenario.incomplete ? "response.incomplete" : "response.completed",
            response: {
              id: `resp_${index}`,
              status: scenario.incomplete ? "incomplete" : "completed",
              ...(scenario.incomplete
                ? { incomplete_details: { reason: "max_output_tokens" } }
                : {}),
              ...(index === 1
                ? endTurn === undefined
                  ? {}
                  : { end_turn: endTurn }
                : { end_turn: index !== 2 }),
              output,
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          }),
        );
      });
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const model: Model<"openai-chatgpt-responses"> = {
      id: "test-model",
      name: "Test model",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const apiKey = `${encode({ alg: "none", typ: "JWT" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-loopback" } })}.signature`;
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "checked" }],
      details: {},
    }));
    const tool: AgentTool = {
      name: "check",
      label: "Check",
      description: "Check the result",
      parameters: Type.Object({}),
      execute,
    };
    try {
      const events: AgentEvent[] = [];
      const result = await runAgentLoop(
        [{ role: "user", content: "Check the result and report it.", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        {
          model,
          convertToLlm: (messages) => messages as Message[],
          shouldStopAfterTurn: () => scenario.stop === true,
          afterToolCall: async () => (scenario.terminateTool ? { terminate: true } : undefined),
        },
        (event) => {
          events.push(event);
          if (scenario.cancel && event.type === "turn_end") {
            controller.abort(new Error("Caller stopped the run"));
          }
        },
        controller.signal,
        (_model, context, options) =>
          streamOpenAICodexResponses(model, context, {
            ...options,
            apiKey,
            transport: "websocket",
          }),
      );
      expect(requests).toHaveLength(scenario.requests);
      expect(execute).toHaveBeenCalledTimes(scenario.requests > 1 ? 1 : 0);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      const assistants = result
        .filter((message) => message.role === "assistant")
        .filter((message) => message.responseId !== undefined);
      expect(assistants).toHaveLength(scenario.requests);
      for (const [index, assistant] of assistants.entries()) {
        const providerEndTurn = index === 0 ? endTurn : index !== 1;
        expect(assistant.diagnostics).toEqual([
          {
            type: "openai_responses_terminal",
            timestamp: expect.any(Number),
            details: {
              eventType: scenario.incomplete ? "response.incomplete" : "response.completed",
              stopReason: scenario.incomplete ? "length" : "stop",
              responseStatus: scenario.incomplete ? "incomplete" : "completed",
              hasRefusal: false,
              hasError: false,
              hasIncompleteDetails: scenario.incomplete === true,
              ...(scenario.incomplete ? { incompleteReason: "max_output_tokens" } : {}),
              endTurn:
                typeof providerEndTurn === "boolean"
                  ? providerEndTurn
                  : providerEndTurn === undefined
                    ? "absent"
                    : "invalid",
            },
          },
        ]);
      }
      expect(JSON.stringify(requests)).not.toContain("openai_responses_terminal");
      if (scenario.requests === 3) {
        expect(result.at(-1)).toMatchObject({
          role: "assistant",
          content: [expect.objectContaining({ text: "The check passed." })],
        });
        expect(requests[1]?.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "message",
              role: "assistant",
              phase: scenario.phase ?? "final_answer",
              content: [expect.objectContaining({ text: "I am checking the result." })],
            }),
          ]),
        );
        expect(requests[2]?.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "call_check",
              output: "checked",
            }),
          ]),
        );
      }
    } finally {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
