import type { Context, StreamOptions, Tool } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { OPENAI_DEFAULT_MODEL } from "../../../../extensions/openai/default-models.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";

const numberTool = {
  name: "record_value",
  description: "Record the supplied value.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

function responseEvents(first: boolean, responseId = first ? "resp_number" : "resp_done") {
  const item = first
    ? {
        type: "function_call",
        id: "fc_number",
        call_id: "call_number",
        name: numberTool.name,
        arguments: '{"n":9007199254740993}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_done",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "recorded", annotations: [] }],
      };
  return [
    ...(first
      ? [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: '{"n":9007199254740993}',
          },
          { type: "response.output_item.done", output_index: 0, item },
        ]
      : []),
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it("preserves reasoning controls in concurrent same-session SSE requests", async () => {
  const server = await createResponsesLoopbackServer((turn) =>
    responseEvents(false, `resp_${turn}`),
  );
  const accepted = createDeferred();
  const release = createDeferred();
  const run = async (
    messages: Context["messages"],
    reasoningEffort: "low" | "medium" | "high",
    onResponse?: StreamOptions["onResponse"],
  ) => {
    const options: OpenAIResponsesOptions = {
      apiKey: "synthetic-continuation-key",
      sessionId: "parallel-reasoning",
      transport: "sse",
      reasoningEffort,
      onResponse,
    };
    const stream = await createOpenAIResponsesTransportStreamFn()(
      { ...responsesLoopbackModel, id: OPENAI_DEFAULT_MODEL.split("/")[1], reasoning: true },
      { messages },
      options,
    );
    return stream.result();
  };
  let active: ReturnType<typeof run> | undefined;
  try {
    const messages: Context["messages"] = [{ role: "user", content: "First.", timestamp: 1 }];
    messages.push(await run(messages, "low"), { role: "user", content: "Second.", timestamp: 2 });
    messages.push(await run(messages, "high"), { role: "user", content: "Third.", timestamp: 3 });
    expect(server.requests[1]?.input).toContainEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
    active = run(messages, "medium", async () => {
      accepted.resolve();
      await release.promise;
    });
    await awaitGateBeforeSettlement(accepted.promise, active, "Expected active HTTP request");
    const concurrent = await run(messages, "medium");
    release.resolve();
    expect((await active).stopReason).toBe("stop");
    expect(concurrent.stopReason).toBe("stop");
    expect(server.requests).toHaveLength(4);
    expect(server.requests[3]).not.toHaveProperty("previous_response_id");
    expect(server.requests[3]).toMatchObject({ reasoning: { effort: "low" } });
    expect(server.requests[3]?.input).toEqual(server.requests[2]?.input);
    expect(server.requests[3]?.input).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      { type: "configuration_update", reasoning: { effort: "high" } },
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      { type: "configuration_update", reasoning: { effort: "medium" } },
      expect.objectContaining({ role: "user" }),
    ]);
  } finally {
    release.resolve();
    await active;
    await server.close();
  }
});

it.each([
  ["sse", "none"],
  ["sse", "sent-type"],
] as const)(
  "preserves real %s continuation with edited arguments=%s",
  async (transport, edited) => {
    const server = await createResponsesLoopbackServer((turn) => responseEvents(turn === 1));
    const { requests } = server;
    const run = async (messages: Context["messages"]) => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
        { messages, tools: [numberTool] },
        {
          apiKey: "synthetic-continuation-key",
          sessionId: `wire-${transport}-${edited}`,
          transport,
          onPayload: (payload) => ({ ...(payload as Record<string, unknown>), store: true }),
        },
      );
      return stream.result();
    };
    try {
      const user = { role: "user" as const, content: "Record 9007199254740993.", timestamp: 1 };
      const first = await run([user]);
      expect(first.stopReason).toBe("toolUse");
      const call = first.content.find((block) => block.type === "toolCall");
      expect(call?.arguments).toEqual({ n: "9007199254740993" });
      if (!call) {
        throw new Error("Expected a completed tool call");
      }
      const replay = structuredClone(first);
      const editedValue = edited === "sent-type" ? 9007199254740992 : "9007199254740992";
      if (edited !== "none") {
        replay.content = [{ ...call, arguments: { n: editedValue } }];
      }
      const result = {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "ok" }],
        isError: false,
        timestamp: 2,
      };
      const second = await run([user, replay, result]);
      expect(second.stopReason).toBe("stop");
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.type)).toEqual([undefined, undefined]);
      if (edited !== "none") {
        expect(requests[1]).not.toHaveProperty("previous_response_id");
        expect(requests[1]?.input).toContainEqual(
          expect.objectContaining({
            type: "function_call",
            arguments: JSON.stringify({ n: editedValue }),
          }),
        );
      } else {
        expect(requests[1]).toMatchObject({
          previous_response_id: "resp_number",
          input: [{ type: "function_call_output", call_id: "call_number", output: "ok" }],
        });
      }
      expect(first.content.find((block) => block.type === "toolCall")?.arguments).toEqual({
        n: "9007199254740993",
      });
      if (edited === "sent-type") {
        const changedReplay = {
          ...replay,
          content: [{ ...call, arguments: { n: "9007199254740992" } }],
        };
        const third = await run([
          user,
          changedReplay,
          result,
          second,
          { role: "user", content: "Continue.", timestamp: 3 },
        ]);
        expect(third.stopReason).toBe("stop");
        expect(requests).toHaveLength(3);
        expect(requests[2]?.type).toBeUndefined();
        expect(requests[2]).not.toHaveProperty("previous_response_id");
        expect(requests[2]?.input).toHaveLength(5);
        expect(requests[2]?.input).toContainEqual(
          expect.objectContaining({ type: "function_call", arguments: '{"n":"9007199254740992"}' }),
        );
      }
    } finally {
      await server.close();
    }
  },
);

it.each(["sse", "websocket-cached"] as const)(
  "recovers real %s continuation after payload serialization fails",
  async (transport) => {
    const server = await createResponsesLoopbackServer((turn) =>
      responseEvents(false, `resp_${turn}`),
    );
    const run = async (messages: Context["messages"], failSerialization = false) => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
        { messages },
        {
          apiKey: "synthetic-continuation-key",
          sessionId: `serialization-${transport}`,
          transport,
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            store: true,
            ...(failSerialization
              ? {
                  metadata: {
                    value: {
                      toJSON() {
                        throw new Error("synthetic continuation serialization failure");
                      },
                    },
                  },
                }
              : {}),
          }),
        },
      );
      return stream.result();
    };
    try {
      const user = { role: "user" as const, content: "First.", timestamp: 1 };
      const first = await run([user]);
      expect(first.stopReason).toBe("stop");
      const messages: Context["messages"] = [
        user,
        first,
        { role: "user", content: "Second.", timestamp: 2 },
      ];
      const failed = await run(messages, true);
      expect(failed.stopReason).toBe("error");
      expect(failed.errorMessage).toBe("synthetic continuation serialization failure");
      expect(server.requests).toHaveLength(1);

      const second = await run(messages);
      expect(second.stopReason).toBe("stop");
      expect(server.requests[1]).not.toHaveProperty("previous_response_id");
      expect(server.requests[1]?.input).toHaveLength(3);
      const third = await run([
        ...messages,
        second,
        { role: "user", content: "Third.", timestamp: 3 },
      ]);
      expect(third.stopReason).toBe("stop");
      expect(server.requests).toHaveLength(3);
      expect(server.requests[2]).toMatchObject({
        previous_response_id: "resp_2",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Third." }] },
        ],
      });
    } finally {
      await server.close();
    }
  },
);

describe("streamed argument conflicts", () => {
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

  function conflictingArgumentEvents(identityConflict: boolean) {
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

  it.each([
    { transport: "sse", identityConflict: false },
    { transport: "sse", identityConflict: true },
    { transport: "websocket-cached", identityConflict: true },
  ] as const)(
    "real $transport stale snapshot: identity conflict=$identityConflict",
    async ({ transport, identityConflict }) => {
      const server = await createResponsesLoopbackServer(
        conflictingArgumentEvents(identityConflict),
      );
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
});

describe("tool changes and continuation identity", () => {
  const recordTool: Tool = {
    name: "record_value",
    description: "Record the supplied value.",
    parameters: {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
      additionalProperties: false,
    },
  };
  const verifyTool: Tool = { ...recordTool, name: "verify_value" };
  const revisedTool: Tool = {
    ...recordTool,
    description: "Record the supplied value and its revision.",
    parameters: {
      type: "object",
      properties: { n: { type: "integer" }, revision: { type: "integer", const: 2 } },
      required: ["n", "revision"],
      additionalProperties: false,
    },
  };
  const scenarios = [
    { transport: "sse", name: "schema", after: [revisedTool], continues: true },
    { transport: "sse", name: "tool-choice", after: [recordTool, verifyTool], continues: false },
    { transport: "sse", name: "key", after: [recordTool, verifyTool], continues: false },
    { transport: "sse", name: "session", after: [recordTool, verifyTool], continues: false },
    {
      transport: "websocket-cached",
      name: "key",
      after: [recordTool, verifyTool],
      continues: false,
    },
    {
      transport: "websocket-cached",
      name: "session",
      after: [recordTool, verifyTool],
      continues: false,
    },
  ] as const;

  function toolChangeEvents(turn: number) {
    const item =
      turn === 1
        ? {
            type: "function_call",
            id: "fc_value",
            call_id: "call_value",
            name: recordTool.name,
            arguments: '{"n":7}',
            status: "completed",
          }
        : {
            type: "message",
            id: `msg_${turn}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: `done ${turn}`, annotations: [] }],
          };
    return [
      ...(turn === 1
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "", status: "in_progress" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: item.id,
              delta: '{"n":7}',
            },
            { type: "response.output_item.done", output_index: 0, item },
          ]
        : []),
      {
        type: "response.completed",
        response: {
          id: `resp_${turn}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      },
    ];
  }

  it.each(scenarios)(
    "real $transport continuation with $name tools",
    async ({ transport, ...scenario }) => {
      const server = await createResponsesLoopbackServer(toolChangeEvents);
      const { requests, authorization } = server;
      const prepared: Array<Record<string, unknown>> = [];
      const run = async (context: Context, later = false) => {
        const stream = await createOpenAIResponsesTransportStreamFn()(
          responsesLoopbackModel,
          context,
          {
            apiKey: later && scenario.name === "key" ? "synthetic-key-b" : "synthetic-key-a",
            sessionId: `${transport}-${scenario.name}-${later && scenario.name === "session" ? "b" : "a"}`,
            cacheRetention: "none",
            transport,
            onPayload: (payload) => {
              const request = {
                ...(payload as Record<string, unknown>),
                store: true,
                tool_choice: later && scenario.name === "tool-choice" ? "none" : "auto",
              };
              prepared.push(request);
              return request;
            },
          },
        );
        return stream.result();
      };
      try {
        const user = { role: "user" as const, content: "Record 7.", timestamp: 1 };
        const first = await run({ messages: [user], tools: [recordTool] });
        expect(first.stopReason).toBe("toolUse");
        const firstSnapshot = structuredClone(first);
        const preparedSnapshot = structuredClone(prepared[0]);
        const call = first.content.find((block) => block.type === "toolCall");
        if (!call) {
          throw new Error("Expected a completed tool call");
        }
        const result = {
          role: "toolResult" as const,
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text" as const, text: "ok" }],
          isError: false,
          timestamp: 2,
        };
        const messages: Context["messages"] = [user, first, result];
        const second = await run({ messages, tools: [...scenario.after] }, true);
        const nextUser = { role: "user" as const, content: "Continue.", timestamp: 3 };
        const third = await run(
          { messages: [...messages, second, nextUser], tools: [...scenario.after] },
          true,
        );
        expect(second.stopReason).toBe("stop");
        expect(third.stopReason).toBe("stop");
        expect(requests).toHaveLength(3);
        expect(requests.map((request) => request.type)).toEqual(
          transport === "websocket-cached"
            ? ["response.create", "response.create", "response.create"]
            : [undefined, undefined, undefined],
        );
        const identityChanged = ["key", "session"].includes(scenario.name);
        const socketCount = identityChanged ? 2 : 1;
        expect(server.connections).toBe(transport === "sse" ? 0 : socketCount);
        const firstAuthorization = "Bearer synthetic-key-a";
        const laterAuthorization =
          scenario.name === "key" ? "Bearer synthetic-key-b" : firstAuthorization;
        const expectedAuthorization =
          transport === "sse"
            ? [firstAuthorization, laterAuthorization, laterAuthorization]
            : identityChanged
              ? [firstAuthorization, laterAuthorization]
              : [firstAuthorization];
        expect(authorization).toEqual(expectedAuthorization);
        expect(first).toEqual(firstSnapshot);
        expect(prepared[0]).toEqual(preparedSnapshot);
        for (const turn of [1, 2]) {
          expect(requests[turn]?.tools).toEqual(prepared[turn]?.tools);
          expect(requests[turn]?.tool_choice).toBe(
            scenario.name === "tool-choice" ? "none" : "auto",
          );
          expect(requests[turn]?.tools).toEqual(
            scenario.after
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map((tool) =>
                expect.objectContaining({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                }),
              ),
          );
        }
        expect(requests[2]).toMatchObject({
          previous_response_id: "resp_2",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
          ],
        });
        if (scenario.continues) {
          expect(requests[1], scenario.name).toMatchObject({
            previous_response_id: "resp_1",
            input: [{ type: "function_call_output", call_id: "call_value", output: "ok" }],
          });
        } else {
          expect(requests[1], scenario.name).not.toHaveProperty("previous_response_id");
          expect(requests[1]?.input).toHaveLength(3);
        }
      } finally {
        await server.close();
      }
    },
  );
});
