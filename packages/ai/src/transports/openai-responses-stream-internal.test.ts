import type { Model } from "@openclaw/llm-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import type { MutableAssistantOutput } from "./openai-transport-shared.js";

type ProcessResponsesStream = NonNullable<
  NonNullable<typeof globalThis.openclawOpenAIResponsesTransportTestApi>
>["processResponsesStream"];

let processResponsesStream: ProcessResponsesStream;

beforeAll(async () => {
  await import("./openai-responses-transport.js");
  const testApi = globalThis.openclawOpenAIResponsesTransportTestApi;
  if (!testApi) {
    throw new Error("OpenAI Responses transport test API was not initialized");
  }
  processResponsesStream = testApi.processResponsesStream;
});

const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openclaw-openai-responses-transport",
  provider: "github-copilot",
  baseUrl: "https://api.githubcopilot.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
} satisfies Model;

function createOutput(): MutableAssistantOutput {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    content: [],
  } as unknown as MutableAssistantOutput;
}

async function* responseEvents(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    yield event;
  }
}

function captureEvents(): { stream: AssistantMessageEventStream; events: AssistantMessageEvent[] } {
  const stream = new AssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [];
  const push = stream.push.bind(stream);
  stream.push = (event) => {
    events.push(event);
    push(event);
  };
  return { stream, events };
}

function functionCall(params: {
  id?: string;
  callId?: string;
  name?: string;
  arguments?: string;
  status?: string;
}) {
  return {
    type: "function_call",
    ...(params.id !== undefined ? { id: params.id } : {}),
    ...(params.callId !== undefined ? { call_id: params.callId } : {}),
    name: params.name ?? "read",
    arguments: params.arguments ?? "",
    ...(params.status !== undefined ? { status: params.status } : {}),
  };
}

function terminalResponse(output: unknown[], id = "resp_terminal") {
  return {
    type: "response.completed",
    response: { id, status: "completed", output },
  };
}

describe("OpenAI Responses terminal tool-call reconciliation", () => {
  it("reconciles an opened call from authoritative response.completed output", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: functionCall({ id: "fc_read", callId: "call_read" }),
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_read",
          delta: '{"path":"README.md"}',
        },
        terminalResponse([
          functionCall({
            id: "fc_read",
            callId: "call_read",
            arguments: '{"path":"README.md","line":12}',
            status: "completed",
          }),
        ]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "README.md", line: 12 },
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("accepts a completed terminal snapshot whose optional status is omitted", async () => {
    const output = createOutput();
    const { stream } = captureEvents();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: functionCall({ id: "fc_read", callId: "call_read" }),
        },
        terminalResponse([
          functionCall({
            id: "fc_read",
            callId: "call_read",
            arguments: '{"path":"README.md"}',
          }),
        ]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content[0]).toMatchObject({ arguments: { path: "README.md" } });
  });

  it("keeps genuinely incomplete terminal calls unresolved", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: functionCall({ id: "fc_partial", callId: "call_partial" }),
          },
          terminalResponse([]),
        ]),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start"]);
  });

  it("reconciles parallel calls by terminal output index", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: functionCall({ id: "fc_first", callId: "call_first", name: "computer" }),
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: functionCall({ id: "fc_second", callId: "call_second", name: "computer" }),
        },
        terminalResponse([
          functionCall({
            id: "fc_first",
            callId: "call_first",
            name: "computer",
            arguments: '{"slot":1}',
            status: "completed",
          }),
          functionCall({
            id: "fc_second",
            callId: "call_second",
            name: "computer",
            arguments: '{"slot":2}',
            status: "completed",
          }),
        ]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toEqual([
      expect.objectContaining({ id: "call_first|fc_first", arguments: { slot: 1 } }),
      expect.objectContaining({ id: "call_second|fc_second", arguments: { slot: 2 } }),
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_end")
        .map((event) => (event.type === "toolcall_end" ? event.contentIndex : undefined)),
    ).toEqual([0, 1]);
  });

  it("rejects a terminal snapshot whose stable call id changes", async () => {
    const output = createOutput();
    const { stream } = captureEvents();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: functionCall({ id: "fc_read", callId: "call_a" }),
          },
          terminalResponse([
            functionCall({
              id: "fc_read_rotated",
              callId: "call_b",
              arguments: '{"path":"README.md"}',
              status: "completed",
            }),
          ]),
        ]),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
  });

  it("rejects terminal snapshots with incomplete status or malformed arguments", async () => {
    for (const terminal of [
      functionCall({
        id: "fc_read",
        callId: "call_read",
        arguments: '{"path":"README.md"}',
        status: "incomplete",
      }),
      functionCall({
        id: "fc_read",
        callId: "call_read",
        arguments: '{"path":"README.md"',
        status: "completed",
      }),
    ]) {
      const output = createOutput();
      const { stream } = captureEvents();
      await expect(
        processResponsesStream(
          responseEvents([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: functionCall({ id: "fc_read", callId: "call_read" }),
            },
            terminalResponse([terminal]),
          ]),
          output,
          stream,
          model,
        ),
      ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    }
  });

  it("rejects malformed completed output_item.done arguments", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: functionCall({ id: "fc_read", callId: "call_read" }),
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: functionCall({
              id: "fc_read",
              callId: "call_read",
              arguments: '{"path":"README.md"',
              status: "completed",
            }),
          },
          terminalResponse([]),
        ]),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start"]);
  });

  it("does not duplicate an identified output_item.done call", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();
    const completed = functionCall({
      id: "fc_once",
      callId: "call_once",
      arguments: '{"path":"ONCE.md"}',
      status: "completed",
    });

    await processResponsesStream(
      responseEvents([
        { type: "response.output_item.added", output_index: 0, item: completed },
        { type: "response.output_item.done", output_index: 0, item: completed },
        { type: "response.output_item.done", output_index: 0, item: completed },
        terminalResponse([completed]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("does not duplicate a tracked call when repeated done events shift identity metadata", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: functionCall({ id: "fc_shift", callId: "call_shift" }),
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: functionCall({
            arguments: '{"path":"SHIFT.md"}',
            status: "completed",
          }),
        },
        {
          type: "response.output_item.done",
          item: functionCall({
            id: "fc_shift",
            callId: "call_shift",
            arguments: '{"path":"SHIFT.md"}',
            status: "completed",
          }),
        },
        terminalResponse([]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("does not duplicate an anonymous output_item.done call", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();
    const completed = functionCall({
      callId: "",
      arguments: '{"path":"ONCE.md"}',
      status: "completed",
    });

    await processResponsesStream(
      responseEvents([
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        { type: "response.output_item.done", item: completed },
        { type: "response.output_item.done", item: completed },
        terminalResponse([]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("emits distinct sequential anonymous output_item.done calls", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await processResponsesStream(
      responseEvents([
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        {
          type: "response.output_item.done",
          item: functionCall({
            callId: "",
            arguments: '{"path":"FIRST.md"}',
            status: "completed",
          }),
        },
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        {
          type: "response.output_item.done",
          item: functionCall({
            callId: "",
            arguments: '{"path":"SECOND.md"}',
            status: "completed",
          }),
        },
        terminalResponse([]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toEqual([
      expect.objectContaining({ arguments: { path: "FIRST.md" } }),
      expect.objectContaining({ arguments: { path: "SECOND.md" } }),
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("emits repeated identical anonymous calls when each has a fresh added event", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();
    const completed = functionCall({
      callId: "",
      arguments: '{"path":"SAME.md"}',
      status: "completed",
    });

    await processResponsesStream(
      responseEvents([
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        { type: "response.output_item.done", item: completed },
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        { type: "response.output_item.done", item: completed },
        terminalResponse([]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("deduplicates anonymous arguments despite object-key ordering", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await processResponsesStream(
      responseEvents([
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        {
          type: "response.output_item.done",
          item: functionCall({
            callId: "",
            arguments: '{"path":"README.md","line":12}',
            status: "completed",
          }),
        },
        {
          type: "response.output_item.done",
          item: functionCall({
            callId: "",
            arguments: '{"line":12,"path":"README.md"}',
            status: "completed",
          }),
        },
        terminalResponse([]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it.each([
    ["indexed then unindexed", 0, undefined],
    ["unindexed then indexed", undefined, 0],
  ])(
    "deduplicates anonymous done events with mixed index metadata: %s",
    async (_label, firstIndex, secondIndex) => {
      const output = createOutput();
      const { stream, events } = captureEvents();
      const completed = functionCall({
        callId: "",
        arguments: '{"path":"MIXED.md"}',
        status: "completed",
      });

      await processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.done",
            ...(firstIndex !== undefined ? { output_index: firstIndex } : {}),
            item: completed,
          },
          {
            type: "response.output_item.done",
            ...(secondIndex !== undefined ? { output_index: secondIndex } : {}),
            item: completed,
          },
          terminalResponse([]),
        ]),
        output,
        stream,
        model,
      );

      expect(output.content).toHaveLength(1);
      expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
    },
  );

  it("emits fresh identical anonymous calls with mixed index metadata", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();
    const completed = functionCall({
      callId: "",
      arguments: '{"path":"MIXED.md"}',
      status: "completed",
    });

    await processResponsesStream(
      responseEvents([
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        { type: "response.output_item.done", output_index: 0, item: completed },
        { type: "response.output_item.added", item: functionCall({ callId: "" }) },
        { type: "response.output_item.done", item: completed },
        terminalResponse([]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("routes a later-indexed anonymous call to its terminal snapshot", async () => {
    const output = createOutput();
    const { stream } = captureEvents();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: functionCall({ callId: "", arguments: "" }),
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"path":"LATE.md"}',
        },
        terminalResponse([
          functionCall({
            callId: "",
            arguments: '{"path":"LATE.md"}',
            status: "completed",
          }),
        ]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content[0]).toMatchObject({ arguments: { path: "LATE.md" } });
  });

  it("fails closed for parallel anonymous terminal calls", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await expect(
      processResponsesStream(
        responseEvents([
          { type: "response.output_item.added", item: functionCall({ callId: "" }) },
          { type: "response.output_item.added", item: functionCall({ callId: "" }) },
          terminalResponse([
            functionCall({ callId: "", arguments: '{"slot":1}', status: "completed" }),
            functionCall({ callId: "", arguments: '{"slot":2}', status: "completed" }),
          ]),
        ]),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("does not materialize incomplete snapshot-only terminal tool calls", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();

    await processResponsesStream(
      responseEvents([
        terminalResponse([
          functionCall({
            id: "fc_snapshot_only",
            callId: "call_snapshot_only",
            arguments: '{"path":"README.md"}',
            status: "incomplete",
          }),
        ]),
      ]),
      output,
      stream,
      model,
    );

    expect(output.content).toEqual([]);
    expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
  });

  it("does not finalize an incomplete output_item.done before response.incomplete", async () => {
    const output = createOutput();
    const { stream, events } = captureEvents();
    const incomplete = functionCall({
      id: "fc_read",
      callId: "call_read",
      arguments: '{"path":"README.md"}',
      status: "incomplete",
    });

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: functionCall({ id: "fc_read", callId: "call_read" }),
          },
          { type: "response.output_item.done", output_index: 0, item: incomplete },
          {
            type: "response.incomplete",
            response: {
              id: "resp_incomplete",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [incomplete],
            },
          },
        ]),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start"]);
  });

  it("never reconciles tool calls from response.incomplete", async () => {
    const output = createOutput();
    const { stream } = captureEvents();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: functionCall({ id: "fc_read", callId: "call_read" }),
          },
          {
            type: "response.incomplete",
            response: {
              id: "resp_incomplete",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [
                functionCall({
                  id: "fc_read",
                  callId: "call_read",
                  arguments: '{"path":"README.md"}',
                  status: "completed",
                }),
              ],
            },
          },
        ]),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
  });
});
