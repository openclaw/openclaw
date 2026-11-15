import { readFileSync } from "node:fs";
import type { Context, Model, SimpleStreamOptions, StreamOptions, Tool } from "@openclaw/llm-core";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it, onTestFinished } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";
import { supportsResponsesReasoningUpdate } from "./openai-responses-reasoning-update.js";
import {
  collectEventTypes,
  argumentDelta,
  completedResponse,
  outputItem,
  userMessage,
  wireMessage,
  wireCall,
  wireUser,
} from "./openai-stream-cases.test-support.js";

const numberTool = {
  name: "record_value",
  description: "Record the supplied value.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

async function loopback(events: Parameters<typeof createResponsesLoopbackServer>[0]) {
  const server = await createResponsesLoopbackServer(events);
  onTestFinished(() => server.close());
  return server;
}

function reasoningItem(turn: number) {
  return {
    id: `rs_step_${turn}`,
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Display-only reasoning." }],
    status: "completed",
    encrypted_content: `opaque_${turn}`,
  };
}

function responseEvents(
  first: boolean,
  responseId = first ? "resp_number" : "resp_done",
  suffix = "",
  callOverrides: Partial<{ id: string; call_id: string; arguments: string }> = {},
  message = { id: "msg_done", text: "recorded" },
  reasoning?: object,
) {
  const call = {
    ...wireCall(`number${suffix}`, numberTool.name, '{"n":9007199254740993}'),
    status: "completed",
    ...callOverrides,
  };
  const item = first ? call : wireMessage(message.id, message.text);
  const index = reasoning ? 1 : 0;
  return [
    ...(reasoning
      ? [outputItem("added", { ...reasoning, summary: [] }), outputItem("done", reasoning)]
      : []),
    ...(first
      ? [
          outputItem("added", { ...item, arguments: "", status: "in_progress" }, index),
          argumentDelta(item.id, call.arguments, index),
          outputItem("done", item, index),
        ]
      : []),
    completedResponse(responseId, [...(reasoning ? [reasoning] : []), item], {
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }),
  ];
}

async function respond(
  context: Context,
  options: SimpleStreamOptions & OpenAIResponsesOptions,
  model: Model = responsesLoopbackModel,
) {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, options);
  return stream.result();
}

it.each([true, false])(
  "keeps recorded three-step tool-loop prefixes byte-identical with store=%s",
  async (store) => {
    const server = await loopback((turn) =>
      responseEvents(turn < 3, `resp_step_${turn}`, `_${turn}`, {}, undefined, reasoningItem(turn)),
    );
    const prepared: Record<string, unknown>[] = [];
    const messages: Context["messages"] = [userMessage("Record three values.")];
    const snapshots: string[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      const assistant = await respond(
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
      expect(Object.hasOwn(assistant, "errorMessage")).toBe(false);
      const thinking = assistant.content.find((block) => block.type === "thinking");
      assert(thinking?.type === "thinking");
      expect(thinking.thinking).toBe("Display-only reasoning.");
      expect(thinking.thinkingSignature).toBe(
        JSON.stringify({ ...reasoningItem(turn), summary: [] }),
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
        messages.push(makeTextToolResult(call.id, call.name, `recorded-${turn}`, false, turn + 1));
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
  const server = await loopback((turn) => responseEvents(false, `resp_${turn}`));
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
    return respond({ messages }, options, {
      ...responsesLoopbackModel,
      id: reasoningModel.id,
      reasoning: true,
    });
  };
  let active: ReturnType<typeof run> | undefined;
  try {
    const messages: Context["messages"] = [userMessage("First.")];
    messages.push(await run(messages, "low"), userMessage("Second.", 2));
    messages.push(await run(messages, "high"), userMessage("Third.", 3));
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
  }
});

it.each([
  ["sse", "none"],
  ["sse", "sent-type"],
] as const)(
  "preserves real %s continuation with edited arguments=%s",
  async (transport, edited) => {
    const server = await loopback((turn) => responseEvents(turn === 1));
    const { requests } = server;
    const run = (messages: Context["messages"]) =>
      respond(
        { messages, tools: [numberTool] },
        {
          apiKey: "synthetic-continuation-key",
          sessionId: `wire-${transport}-${edited}`,
          transport,
          onPayload: (payload) => ({ ...(payload as Record<string, unknown>), store: true }),
        },
      );
    const user = userMessage("Record 9007199254740993.");
    const first = await run([user]);
    expect(first.stopReason).toBe("toolUse");
    const call = first.content.find((block) => block.type === "toolCall");
    expect(call?.arguments).toEqual({ n: "9007199254740993" });
    assert(call, "Expected a completed tool call");
    const replay = structuredClone(first);
    const editedValue = edited === "sent-type" ? 9007199254740992 : "9007199254740992";
    if (edited !== "none") {
      replay.content = [{ ...call, arguments: { n: editedValue } }];
    }
    const result = makeTextToolResult(call.id, call.name, "ok", false, 2);
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
      const third = await run([user, changedReplay, result, second, userMessage("Continue.", 3)]);
      expect(third.stopReason).toBe("stop");
      expect(requests).toHaveLength(3);
      expect(requests[2]?.type).toBeUndefined();
      expect(requests[2]).not.toHaveProperty("previous_response_id");
      expect(requests[2]?.input).toHaveLength(5);
      expect(requests[2]?.input).toContainEqual(
        expect.objectContaining({ type: "function_call", arguments: '{"n":"9007199254740992"}' }),
      );
    }
  },
);

it.each(["sse", "websocket-cached"] as const)(
  "recovers real %s continuation after payload serialization fails",
  async (transport) => {
    const server = await loopback((turn) => responseEvents(false, `resp_${turn}`));
    const unserializable = {
      toJSON() {
        throw new Error("synthetic continuation serialization failure");
      },
    };
    const run = (messages: Context["messages"], failSerialization = false) =>
      respond(
        { messages },
        {
          apiKey: "synthetic-continuation-key",
          sessionId: `serialization-${transport}`,
          transport,
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            store: true,
            metadata: failSerialization ? unserializable : undefined,
          }),
        },
      );
    const user = userMessage("First.");
    const first = await run([user]);
    expect(first.stopReason).toBe("stop");
    const messages: Context["messages"] = [user, first, userMessage("Second.", 2)];
    const failed = await run(messages, true);
    expect(failed).toMatchObject({
      stopReason: "error",
      errorMessage: "synthetic continuation serialization failure",
    });
    expect(server.requests).toHaveLength(1);

    const second = await run(messages);
    expect(second.stopReason).toBe("stop");
    expect(server.requests[1]).not.toHaveProperty("previous_response_id");
    expect(server.requests[1]?.input).toHaveLength(3);
    const third = await run([...messages, second, userMessage("Third.", 3)]);
    expect(third.stopReason).toBe("stop");
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]).toMatchObject({
      previous_response_id: "resp_2",
      input: [wireUser("Third.")],
    });
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
      ...wireCall("lookup", lookupTool.name),
      status: "completed",
    };
    return () => [
      outputItem("added", { ...call, arguments: "", status: "in_progress" }),
      ...[streamedArguments.slice(0, 10), streamedArguments.slice(10)].map((delta) =>
        argumentDelta(call.id, delta),
      ),
      outputItem("done", { ...call, arguments: staleArguments }),
      completedResponse(
        "resp_argument_conflict",
        [
          {
            ...call,
            call_id: identityConflict ? "call_terminal_conflict" : call.call_id,
            arguments: streamedArguments,
          },
        ],
        {
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      ),
    ];
  }

  it.each([
    { transport: "sse", identityConflict: false },
    { transport: "sse", identityConflict: true },
    { transport: "websocket-cached", identityConflict: true },
  ] as const)(
    "real $transport stale snapshot: identity conflict=$identityConflict",
    async ({ transport, identityConflict }) => {
      const server = await loopback(conflictingArgumentEvents(identityConflict));
      const context: Context = {
        messages: [userMessage("Look up README.")],
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
      const events = await collectEventTypes(stream);
      const result = await stream.result();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");

      expect(server).toMatchObject({
        connections: transport === "sse" ? 0 : 1,
        authorization: ["Bearer synthetic-key-a"],
      });
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
      expect(JSON.stringify(result.content)).not.toContain('READ"');
    },
  );
});

describe("tool changes and continuation identity", () => {
  const recordTool: Tool = {
    ...numberTool,
    parameters: { ...numberTool.parameters, additionalProperties: false },
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
  it.each([
    ["sse", "schema"],
    ["sse", "tool-choice"],
    ["sse", "key"],
    ["sse", "session"],
    ["websocket-cached", "key"],
    ["websocket-cached", "session"],
  ] as const)("real %s continuation with %s tools", async (transport, change) => {
    const toolsAfter = change === "schema" ? [revisedTool] : [recordTool, verifyTool];
    const server = await loopback((turn) =>
      responseEvents(
        turn === 1,
        `resp_${turn}`,
        "",
        wireCall("value", numberTool.name, '{"n":7}'),
        { id: `msg_${turn}`, text: `done ${turn}` },
      ),
    );
    const { requests, authorization } = server;
    const prepared: Array<Record<string, unknown>> = [];
    const run = (context: Context, later = false) =>
      respond(context, {
        apiKey: later && change === "key" ? "synthetic-key-b" : "synthetic-key-a",
        sessionId: `${transport}-${change}-${later && change === "session" ? "b" : "a"}`,
        cacheRetention: "none",
        transport,
        onPayload: (payload) => {
          const request = {
            ...(payload as Record<string, unknown>),
            store: true,
            tool_choice: later && change === "tool-choice" ? "none" : "auto",
          };
          prepared.push(request);
          return request;
        },
      });
    const user = userMessage("Record 7.");
    const first = await run({ messages: [user], tools: [recordTool] });
    expect(first.stopReason).toBe("toolUse");
    const firstSnapshot = structuredClone(first);
    const preparedSnapshot = structuredClone(prepared[0]);
    const call = first.content.find((block) => block.type === "toolCall");
    assert(call, "Expected a completed tool call");
    const result = makeTextToolResult(call.id, call.name, "ok", false, 2);
    const messages: Context["messages"] = [user, first, result];
    const second = await run({ messages, tools: toolsAfter }, true);
    const nextUser = userMessage("Continue.", 3);
    const third = await run({ messages: [...messages, second, nextUser], tools: toolsAfter }, true);
    expect([second.stopReason, third.stopReason]).toEqual(["stop", "stop"]);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.type)).toEqual(
      transport === "websocket-cached"
        ? ["response.create", "response.create", "response.create"]
        : [undefined, undefined, undefined],
    );
    const identityChanged = ["key", "session"].includes(change);
    const socketCount = identityChanged ? 2 : 1;
    expect(server.connections).toBe(transport === "sse" ? 0 : socketCount);
    const firstAuthorization = "Bearer synthetic-key-a";
    const laterAuthorization = change === "key" ? "Bearer synthetic-key-b" : firstAuthorization;
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
      expect(requests[turn]?.tool_choice).toBe(change === "tool-choice" ? "none" : "auto");
      expect(requests[turn]?.tools).toEqual(
        toolsAfter
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map(({ name, description, parameters }) =>
            expect.objectContaining({ type: "function", name, description, parameters }),
          ),
      );
    }
    expect(requests[2]).toMatchObject({
      previous_response_id: "resp_2",
      input: [wireUser("Continue.")],
    });
    if (change === "schema") {
      expect(requests[1], change).toMatchObject({
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_value", output: "ok" }],
      });
    } else {
      expect(requests[1], change).not.toHaveProperty("previous_response_id");
      expect(requests[1]?.input).toHaveLength(3);
    }
  });
});
