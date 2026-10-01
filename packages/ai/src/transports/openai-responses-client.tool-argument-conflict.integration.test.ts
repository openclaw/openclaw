// Keep #139110's stale-argument regression on both real transports.
import type { Context, Tool } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";

const lookupTool: Tool = {
  name: "lookup",
  description: "Look up a file by path.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, record_id: { type: ["integer", "string"] } },
    required: ["path"],
    additionalProperties: false,
  },
};
const streamedArguments = '{"path":"README.md","record_id":9007199254740993}';
const staleArguments = '{"path":"READ"}';
const completeArguments = {
  path: "README.md",
  record_id: "9007199254740993",
};

function responseEvents(identityConflict: boolean) {
  const call = {
    type: "function_call",
    id: "fc_lookup",
    call_id: "call_lookup",
    name: lookupTool.name,
    status: "completed",
  };
  return () => [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "", status: "in_progress" },
    },
    ...[streamedArguments.slice(0, 10), streamedArguments.slice(10)].map((delta) => ({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: call.id,
      delta,
    })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, arguments: staleArguments },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_argument_conflict",
        status: "completed",
        output: [
          {
            ...call,
            call_id: identityConflict ? "call_terminal_conflict" : call.call_id,
            arguments: streamedArguments,
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it.each(
  (["sse", "websocket-cached"] as const).flatMap((transport) =>
    [false, true].map((identityConflict) => ({ transport, identityConflict })),
  ),
)(
  "real $transport stale snapshot: identity conflict=$identityConflict",
  async ({ transport, identityConflict }) => {
    const server = await createResponsesLoopbackServer(responseEvents(identityConflict));
    try {
      const context: Context = {
        messages: [{ role: "user", content: "Look up README.", timestamp: 1 }],
        tools: [lookupTool],
      };
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
        context,
        {
          apiKey: "synthetic-key-a",
          sessionId: `${transport}-${identityConflict}`,
          cacheRetention: "none",
          transport,
        },
      );
      const events: string[] = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");

      // The request really left through the selected transport.
      expect(server.connections).toBe(transport === "sse" ? 0 : 1);
      expect(server.authorization).toEqual(["Bearer synthetic-key-a"]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.tools).toEqual([
        expect.objectContaining({ type: "function", name: lookupTool.name }),
      ]);

      expect(result.stopReason).toBe(identityConflict ? "error" : "toolUse");
      if (identityConflict) {
        expect(events).toEqual([
          "start",
          "toolcall_start",
          "toolcall_delta",
          "toolcall_delta",
          "toolcall_end",
          "error",
        ]);
        expect(result.errorCode).toBe("responses_output_identity_conflict");
        expect(JSON.parse(result.errorBody ?? "{}")).toEqual({
          outputIndex: 0,
          expectedType: "function_call",
          actualType: "function_call",
          completed: true,
          completedToolCall: true,
          eventType: "response.completed",
          retrySafe: false,
          mismatch: "call_id",
        });
      }
      expect(events.filter((type) => type === "toolcall_end")).toEqual(["toolcall_end"]);
      expect(toolCalls).toEqual([
        expect.objectContaining({ name: lookupTool.name, arguments: completeArguments }),
      ]);
      // The stale snapshot must never reach the transcript.
      expect(JSON.stringify(result.content)).not.toContain('READ"');
    } finally {
      await server.close();
    }
  },
);
