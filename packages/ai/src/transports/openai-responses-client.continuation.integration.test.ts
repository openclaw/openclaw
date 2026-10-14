import { readFileSync } from "node:fs";
import type { Context, StreamOptions, Tool } from "@openclaw/llm-core";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";
import { supportsResponsesReasoningUpdate } from "./openai-responses-reasoning-update.js";

const numberTool = {
  name: "record_value",
  description: "Record the supplied value.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

function responseEvents(
  first: boolean,
  responseId = first ? "resp_number" : "resp_done",
  suffix = "",
) {
  const item = first
    ? {
        type: "function_call",
        id: `fc_number${suffix}`,
        call_id: `call_number${suffix}`,
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

it.each([true, false])(
  "keeps recorded three-step tool-loop prefixes byte-identical with store=%s",
  async (store) => {
    const server = await createResponsesLoopbackServer((turn) => {
      const events = responseEvents(turn < 3, `resp_step_${turn}`, `_${turn}`);
      const reasoning = {
        encrypted_content: `opaque_${turn}`,
        status: "completed",
        summary: [{ type: "summary_text", text: "Display-only reasoning." }],
        type: "reasoning",
        id: `rs_step_${turn}`,
      };
      const shifted = events.map((event) => {
        if ("response" in event) {
          const response = event.response;
          assert(response);
          return Object.assign({}, event, {
            response: Object.assign({}, response, {
              output: [reasoning, ...response.output],
            }),
          });
        }
        return Object.assign({}, event, { output_index: event.output_index + 1 });
      });
      return [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...reasoning, summary: [] },
        },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        ...shifted,
      ];
    });
    const prepared: Record<string, unknown>[] = [];
    const messages: Context["messages"] = [
      { role: "user", content: "Record three values.", timestamp: 1 },
    ];
    const snapshots: string[] = [];
    try {
      for (let turn = 1; turn <= 3; turn++) {
        const stream = await createOpenAIResponsesTransportStreamFn()(
          responsesLoopbackModel,
          { systemPrompt: "Use the supplied tool.", messages, tools: [numberTool] },
          {
            apiKey: "synthetic-continuation-key",
            sessionId: `recorded-tool-loop-${store}`,
            transport: "sse",
            onPayload(payload) {
              const request = {
                ...(payload as Record<string, unknown>),
                store,
                metadata: { openclaw_turn_id: `turn-${turn}` },
              };
              prepared.push(structuredClone(request));
              return request;
            },
          },
        );
        const assistant = await stream.result();
        expect(Object.hasOwn(assistant, "errorMessage")).toBe(false);
        const thinking = assistant.content.find((block) => block.type === "thinking");
        assert(thinking?.type === "thinking");
        expect(thinking.thinking).toBe("Display-only reasoning.");
        expect(thinking.thinkingSignature).toBe(
          JSON.stringify({
            id: `rs_step_${turn}`,
            type: "reasoning",
            summary: [],
            status: "completed",
            encrypted_content: `opaque_${turn}`,
          }),
        );
        expect(
          messages
            .filter((message) => message.role === "assistant")
            .map((message) => JSON.stringify(message)),
        ).toEqual(snapshots);
        messages.push(assistant);
        snapshots.push(JSON.stringify(assistant));
        if (turn < 3) {
          const call = assistant.content.find((block) => block.type === "toolCall");
          assert(call?.type === "toolCall");
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `recorded-${turn}` }],
            isError: false,
            timestamp: turn + 1,
          });
        }
      }
      expect(server.rawRequests).toEqual(server.requests.map((request) => JSON.stringify(request)));
      for (let index = 1; index < 3; index++) {
        const previous = prepared[index - 1];
        const current = prepared[index];
        assert(previous && current);
        assert(Array.isArray(previous.input) && Array.isArray(current.input));
        expect(JSON.stringify(current.input.slice(0, previous.input.length))).toBe(
          JSON.stringify(previous.input),
        );
        const stableParameters = ({
          input: _input,
          metadata: _metadata,
          ...parameters
        }: Record<string, unknown>) => JSON.stringify(parameters);
        expect(stableParameters(current)).toBe(stableParameters(previous));
        const request = server.requests[index];
        assert(request);
        if (store) {
          expect(request.previous_response_id).toBe(`resp_step_${index}`);
          expect(request.input).toEqual([
            {
              type: "function_call_output",
              call_id: `call_number_${index}`,
              output: `recorded-${index}`,
            },
          ]);
        } else {
          expect(request).not.toHaveProperty("previous_response_id");
          const previousWire = server.requests[index - 1]?.input;
          assert(Array.isArray(previousWire) && Array.isArray(request.input));
          expect(JSON.stringify(request.input.slice(0, previousWire.length))).toBe(
            JSON.stringify(previousWire),
          );
        }
      }
    } finally {
      await server.close();
    }
  },
);

it("preserves reasoning controls in concurrent same-session SSE requests", async () => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL("../../../../extensions/openai/openclaw.plugin.json", import.meta.url),
      "utf8",
    ),
  );
  assert(isRecord(manifest), "Expected the registered OpenAI model catalog");
  const catalog = normalizeModelCatalog(manifest.modelCatalog, {
    ownedProviders: new Set(["openai"]),
  });
  const reasoningModel = catalog?.providers?.openai?.models.find((entry) =>
    supportsResponsesReasoningUpdate({ model: entry.id, reasoning: { effort: "low" }, input: [] }),
  );
  assert(reasoningModel, "Expected a registered model supporting reasoning controls");
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
    const options = {
      apiKey: "synthetic-continuation-key",
      sessionId: "parallel-reasoning",
      transport: "sse",
      reasoningEffort,
      onResponse,
    } satisfies OpenAIResponsesOptions;
    const stream = await createOpenAIResponsesTransportStreamFn()(
      { ...responsesLoopbackModel, id: reasoningModel.id, reasoning: true },
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
