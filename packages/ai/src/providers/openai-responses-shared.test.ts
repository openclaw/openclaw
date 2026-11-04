import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
} from "../../../../src/shared/immutable-data.js";
import { createResponsesDoneArgumentEvents } from "../../../../test/helpers/openai-responses-events.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createAiTransportHost, runWithAiTransportHost } from "../host.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../transports/openai-responses-compaction-replay.js";
import type { OpenAIResponsesRequestParams } from "../transports/openai-responses-contracts.js";
import { isInvalidEncryptedContentError } from "../transports/openai-responses-replay-internal.js";
import { convertResponsesMessages as convertTransportResponsesMessages } from "../transports/openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { resolveOpenAISimpleReasoningEffort } from "./openai-request-reasoning.js";
import {
  applyCommonResponsesParams,
  createResponsesAssistantOutput,
  convertResponsesMessages,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
async function* streamResponsesEvents<T>(events: readonly T[]): AsyncGenerator<T> {
  yield* events;
}

function createNeverYieldingResponsesStream<T>(): AsyncIterable<T> {
  const pending = new Promise<IteratorResult<T>>(() => {});
  return { [Symbol.asyncIterator]: () => ({ next: () => pending }) };
}

function createCapturedAssistantMessageEventStream(
  observe?: (event: AssistantMessageEvent) => void,
) {
  const stream = new AssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [];
  const push = stream.push.bind(stream);
  stream.push = (event) => {
    observe?.(event);
    events.push(event);
    push(event);
  };
  return { stream, events };
}

const nativeOpenAIModel = makeOpenAIProviderModel("openai-responses", {
  contextWindow: 200000,
  maxTokens: 8192,
});

const proxyOpenAIModel = {
  ...nativeOpenAIModel,
  id: "custom-model",
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-responses">;

const gpt56SolModel = {
  ...nativeOpenAIModel,
  id: "gpt-5.6-sol",
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
} satisfies Model<"openai-responses">;

const testAllowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);
const reasoningReplayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

type LifecycleParams = Parameters<typeof runResponsesStreamLifecycle>[0];
type RequestOptions = Parameters<
  ReturnType<LifecycleParams["createClient"]>["responses"]["create"]
>[1];

function startLifecycle(
  send: (
    attempt: number,
    options: RequestOptions,
  ) => AsyncIterable<ResponseStreamEvent> | Promise<AsyncIterable<ResponseStreamEvent>>,
  params: Pick<LifecycleParams, "options"> & Partial<Pick<LifecycleParams, "buildParams">> = {},
) {
  const output = createAssistantOutput();
  const { stream, events } = createCapturedAssistantMessageEventStream();
  const requests: ResponseCreateParamsStreaming[] = [];
  const done = runResponsesStreamLifecycle({
    model: nativeOpenAIModel,
    output,
    stream,
    buildParams: () => replayRequest([]),
    ...params,
    createClient: () => ({
      responses: {
        create: (request, options) => {
          requests.push(structuredClone(request));
          return {
            withResponse: async () => ({
              data: await send(requests.length, options),
              response: new Response(null, { status: 200 }),
            }),
          };
        },
      },
    }),
  });
  return { output, events, requests, done };
}

type StreamFixtureOptions = {
  model?: Model;
  options?: Parameters<typeof processResponsesStream>[4];
  observe?: (event: AssistantMessageEvent) => void;
};

function startResponses(input: readonly unknown[], params: StreamFixtureOptions = {}) {
  const model = params.model ?? nativeOpenAIModel;
  const output = { ...createResponsesAssistantOutput(model, model.api), timestamp: 0 };
  const { stream, events } = createCapturedAssistantMessageEventStream(params.observe);
  const done = processResponsesStream(
    streamResponsesEvents(input),
    output,
    stream,
    model,
    params.options,
  );
  return { output, events, done };
}

async function collectResponses(input: readonly unknown[], params?: StreamFixtureOptions) {
  const { output, events, done } = startResponses(input, params);
  await done;
  return { output, events };
}

function messageItem(id: string, text: string) {
  return { type: "message" as const, id, content: [{ type: "output_text" as const, text }] };
}

function wireReasoning(id: string, text?: string, encrypted_content?: string) {
  return {
    type: "reasoning" as const,
    id,
    summary: [],
    ...(text === undefined ? {} : { content: [{ type: "reasoning_text" as const, text }] }),
    ...(encrypted_content === undefined ? {} : { encrypted_content }),
  };
}

function argumentsDelta(delta: string, outputIndex?: number, itemId?: string) {
  return {
    type: "response.function_call_arguments.delta",
    delta,
    output_index: outputIndex,
    item_id: itemId,
  };
}

function completed(id: string, fields: object = {}) {
  return { type: "response.completed", response: { id, status: "completed", ...fields } };
}

function argumentsDone(args: string | undefined, outputIndex?: number, itemId?: string) {
  return {
    type: "response.function_call_arguments.done",
    ...(args === undefined ? {} : { arguments: args }),
    output_index: outputIndex,
    item_id: itemId,
  };
}

function itemEvent<P extends "added" | "done", T extends object>(
  phase: P,
  item: T,
  outputIndex?: number,
) {
  return { type: `response.output_item.${phase}` as const, item, output_index: outputIndex };
}

function toolIdentity(id: string, name = "computer") {
  return { type: "function_call" as const, id: `fc_${id}`, call_id: `call_${id}`, name };
}

function toolItem(id: string, args = "", name = "computer") {
  return { ...toolIdentity(id, name), arguments: args };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall" as const, id: `call_${id}|fc_${id}`, name, arguments: args };
}

function replayRequest(input: OpenAIResponsesRequestParams["input"]): OpenAIResponsesRequestParams {
  return { model: nativeOpenAIModel.id, stream: true, input };
}

function createAssistantOutput(): AssistantMessage {
  return { ...createResponsesAssistantOutput(nativeOpenAIModel), timestamp: 0 };
}

const eventTypes = (events: AssistantMessageEvent[]) => events.map((event) => event.type);
const eventPositions = (events: AssistantMessageEvent[]) =>
  events
    .map((event) => `${event.type}@${"contentIndex" in event ? event.contentIndex : "-"}`)
    .join(" ");
const text = (value: string) => ({ type: "text" as const, text: value });
const signedText = (value: string, id: string) => ({
  ...text(value),
  textSignature: JSON.stringify({ v: 1, id, phase: "commentary" }),
});
function thinking(value: string, signature: object) {
  return {
    type: "thinking" as const,
    thinking: value,
    thinkingSignature: JSON.stringify(signature),
  };
}
function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return { ...createAssistantOutput(), content, ...overrides };
}
function replayMessages(
  messages: Context["messages"],
  options?: Parameters<typeof convertResponsesMessages>[3],
  model: Model = nativeOpenAIModel,
) {
  return convertResponsesMessages(model, { messages }, testAllowedToolCallProviders, options);
}

it.each([
  [null, null],
  [undefined, "auto"],
] as const)("sends common Responses summary %s as %s", (reasoningSummary, expected) => {
  const params = {} as { reasoning?: unknown };
  applyCommonResponsesParams(
    params as never,
    nativeOpenAIModel,
    { messages: [] },
    { reasoningEffort: "medium", reasoningSummary },
  );

  expect(params.reasoning).toEqual({ effort: "medium", summary: expected });
});

it("drops Responses temperature for the GPT-5.6 family that rejects it", () => {
  const params = {} as never;
  applyCommonResponsesParams(params, gpt56SolModel, { messages: [] }, { temperature: 0.3 });

  expect(params).not.toHaveProperty("temperature");
});

it.each([
  { model: gpt56SolModel, reasoning: "max", resolvedEffort: "max", expected: "max" },
  {
    model: { ...proxyOpenAIModel, compat: { supportedReasoningEfforts: ["ProviderHigh"] } },
    reasoning: "high",
    resolvedEffort: "high",
    expected: "ProviderHigh",
  },
] satisfies Array<{
  model: Model<"openai-responses">;
  reasoning: "max" | "high";
  resolvedEffort: string;
  expected: string;
}>)(
  "normalizes $reasoning to $expected at the request boundary",
  ({ model, reasoning, resolvedEffort, expected }) => {
    const effort = resolveOpenAISimpleReasoningEffort(model, reasoning);
    expect(effort).toBe(resolvedEffort);
    const params = {} as ResponseCreateParamsStreaming;
    applyCommonResponsesParams(params, model, { messages: [] }, { reasoningEffort: effort });
    expect(params.reasoning).toEqual({ effort: expected, summary: "auto" });
  },
);

describe("convertResponsesMessages", () => {
  it.each([
    ["provider", convertResponsesMessages],
    ["transport", convertTransportResponsesMessages],
  ] as const)("preserves frozen %s bytes, identities and replay fences", (_style, convert) => {
    const host = createAiTransportHost({
      immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
    });
    runWithAiTransportHost(host, () => {
      const model: Model = { ...nativeOpenAIModel, input: ["text", "image"] };
      const image = { type: "image" as const, mimeType: "image/png", data: "aW1n" };
      const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, reasoningReplayIdentity);
      const context: Context = {
        messages: freezeJsonSnapshot([
          { role: "user", timestamp: 0, content: [text("question"), image] },
          assistant(
            [
              thinking("hidden", {
                ...wireReasoning("rs_prior", undefined, "ciphertext"),
                __openclaw_replay: metadata,
              }),
              signedText("answer", "msg_prior"),
              toolCall("read", "read", { path: "a\nb" }),
            ],
            { stopReason: "toolUse" },
          ),
          {
            ...makeTextToolResult("call_read|fc_read", "read", "result", false, 2),
            content: [text("result"), image],
          },
        ]),
      };
      const golden = `[${[
        '{"type":"message","role":"user","content":[{"type":"input_text","text":"question"},{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,aW1n"}]}',
        '{"id":"rs_prior","type":"reasoning","summary":[],"encrypted_content":"ciphertext"}',
        '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer","annotations":[]}],"status":"completed","id":"msg_prior","phase":"commentary"}',
        String.raw`{"type":"function_call","id":"fc_read","call_id":"call_read","name":"read","arguments":"{\"path\":\"a\\nb\"}"}`,
        '{"type":"function_call_output","call_id":"call_read","output":[{"type":"input_text","text":"result"},{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,aW1n"}]}',
      ].join(",")}]`;
      const build = (target = model, options = reasoningReplayIdentity) =>
        convert(target, context, testAllowedToolCallProviders, options);
      const first = build();
      expect(JSON.stringify(first)).toBe(golden);
      for (const [target, options] of [
        [model, { ...reasoningReplayIdentity, sessionId: "other" }],
        [model, { ...reasoningReplayIdentity, authProfileId: "other" }],
        [{ ...model, id: "other-model" }, reasoningReplayIdentity],
        [{ ...model, baseUrl: "https://other.invalid/v1" }, reasoningReplayIdentity],
      ] as const) {
        expect(JSON.stringify(build(target, options))).not.toContain("ciphertext");
        const again = build();
        expect(JSON.stringify(again)).toBe(golden);
        for (const index of [1, 2, 3]) {
          expect(again[index]).toBe(first[index]);
        }
      }
      const idless = convert(model, context, testAllowedToolCallProviders, {
        ...reasoningReplayIdentity,
        replayResponsesItemIds: false,
      });
      expect(JSON.stringify(idless)).toBe(
        golden.replace(/"id":"(?:rs_prior|msg_prior|fc_read)",/g, ""),
      );
      expect(first.slice(1, 4).every(isDeeplyFrozenPlainData)).toBe(true);
    });
  });

  it("strips the internal cache boundary marker from the system prompt message", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      { systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`, messages: [] },
      testAllowedToolCallProviders,
    );
    expect(input[0]).toMatchObject({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Stable\nDynamic" }],
    });
    expect(JSON.stringify(input)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it.each(["stop", "error", "aborted"] as const)(
    "keeps unsigned assistant replay bytes stable when older history retires (%s)",
    (stopReason) => {
      const retired = assistant([text("Earlier answer")], { timestamp: 1 });
      const retained = {
        ...assistant([text("Partial answer"), text("Another text block")]),
        responseId: "resp_retained",
        timestamp: 2,
        stopReason,
        errorMessage: "off-wire synthetic diagnostic",
        __openclaw: { diagnostic: "off-wire metadata" },
      };
      const original = structuredClone(retained);
      const before = replayMessages([retired, retained]);
      const after = replayMessages([retained]);
      expect(after).toEqual(before.slice(1));
      expect(JSON.stringify(after)).not.toContain("off-wire");
      expect(retained).toEqual(original);

      const repeated = replayMessages([retained, { ...retained, responseId: "resp_next" }]);
      const ids = repeated.flatMap((item) =>
        "id" in item && typeof item.id === "string" ? [item.id] : [],
      );
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("keeps async prefixes and a failed tail distinct within one source response", () => {
    const source = { responseId: "resp_shared", turnId: "turn_shared", timestamp: 2 };
    const prefix = (id: string) =>
      assistant(
        [
          { type: "text", text: "Working" },
          { type: "toolCall", id, name: "probe", arguments: {}, async: true },
        ],
        { ...source, stopReason: "toolUse" },
      );
    const messages = [
      prefix("call_one|fc_one"),
      prefix("call_two|fc_two"),
      assistant([text("Working")], { ...source, stopReason: "error" }),
      makeTextToolResult("call_one|fc_one", "probe", "one", false, 3),
      makeTextToolResult("call_two|fc_two", "probe", "two", false, 4),
    ];
    const input = replayMessages(messages);
    const ids = input.flatMap((item) =>
      item.type === "message" && item.role === "assistant" && "id" in item ? [item.id] : [],
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const retired = { role: "user" as const, content: "Earlier turn", timestamp: 1 };
    expect(replayMessages([retired, ...messages]).slice(1)).toEqual(input);
  });

  it("keeps the early turn identity when a response ID arrives later", () => {
    const early = assistant([text("Working")], { turnId: "turn_early", timestamp: 2 });
    expect(replayMessages([{ ...early, responseId: "resp_late" }])).toEqual(
      replayMessages([early]),
    );
  });

  it("keeps legacy same-timestamp inputs distinct without a source turn identity", () => {
    const message = assistant([text("Repeated answer")], { timestamp: 1 });
    const input = replayMessages([message, { ...message }]);
    const ids = input.flatMap((item) =>
      "id" in item && typeof item.id === "string" ? [item.id] : [],
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("omits phase-tagged assistant replay ids without reasoning", () => {
    const input = replayMessages([assistant([signedText("Working...", "msg_commentary")])], {
      includeSystemPrompt: false,
    });
    const message = input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message).toMatchObject({ phase: "commentary" });
    expect(message).not.toHaveProperty("id");
  });

  it.each([
    [
      "image",
      "aW1n",
      [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,aW1n" }],
    ],
    ["image", "", "(no output)"],
    ["audio", "YXVkaW8=", "(see attached audio)"],
  ] as const)(
    "replays %s tool bytes '%s' without spurious placeholders",
    (type, data, expected) => {
      const call = assistant([toolCall("media", "media", {})], { stopReason: "toolUse" });
      const result = {
        ...makeTextToolResult("call_media|fc_media", "media", "", false, 2),
        content: [{ type, data, mimeType: type === "image" ? "image/png" : "audio/mpeg" }],
      };
      const input = replayMessages(
        [...(data ? [call] : []), result] as unknown as Context["messages"],
        { includeSystemPrompt: false },
        { ...nativeOpenAIModel, input: ["text", "image"] },
      );
      expect(input.find((item) => item.type === "function_call_output")).toEqual({
        type: "function_call_output",
        call_id: "call_media",
        output: expected,
      });
    },
  );

  describe.each(["openai-responses", "openai-chatgpt-responses"] as const)(
    "%s reasoning replay",
    (api) => {
      const model = { ...nativeOpenAIModel, api };
      const summary =
        api === "openai-chatgpt-responses" ? [{ type: "summary_text", text: "safe summary" }] : [];
      const content =
        api === "openai-chatgpt-responses"
          ? [{ type: "reasoning_text", text: "safe content" }]
          : undefined;
      const sameRoute = buildOpenAIResponsesReasoningReplayMetadata(model, reasoningReplayIdentity);
      const otherSession = buildOpenAIResponsesReasoningReplayMetadata(model, {
        ...reasoningReplayIdentity,
        sessionId: "session-b",
      });
      it.each([
        ["matching block metadata", sameRoute, otherSession, true],
        ["legacy unattributed metadata", undefined, undefined, true],
        ["mismatched block metadata", otherSession, sameRoute, false],
        ["malformed block metadata", null, sameRoute, false],
        ["mismatched embedded metadata", undefined, otherSession, false],
      ])(
        "fences encrypted reasoning with %s",
        (_name, blockMetadata, embeddedMetadata, preservesCiphertext) => {
          const replayIds = blockMetadata !== undefined || embeddedMetadata !== undefined;
          const signature = {
            type: "reasoning",
            id: "rs_route_fenced",
            encrypted_content: "route-bound-ciphertext",
            summary: [{ type: "summary_text", text: "safe summary" }],
            content: [{ type: "reasoning_text", text: "safe content" }],
            ...(embeddedMetadata !== undefined ? { __openclaw_replay: embeddedMetadata } : {}),
          };
          const block = {
            ...thinking("Safe visible reasoning.", signature),
            ...(blockMetadata !== undefined ? { openclawReasoningReplay: blockMetadata } : {}),
          };
          const input = replayMessages(
            [assistant([block] as unknown as AssistantMessage["content"], { api: model.api })],
            {
              includeSystemPrompt: false,
              replayResponsesItemIds: replayIds,
              ...reasoningReplayIdentity,
            },
            model,
          );
          const item = input.find((entry) => entry.type === "reasoning");
          expect(item).toEqual(
            preservesCiphertext
              ? {
                  ...(replayIds ? { id: "rs_route_fenced" } : {}),
                  type: "reasoning",
                  summary,
                  ...(content ? { content } : {}),
                  encrypted_content: "route-bound-ciphertext",
                }
              : undefined,
          );
        },
      );
    },
  );
});

describe("processResponsesStream", () => {
  it.each([
    {
      name: "rejects reuse of an active Responses tool-call output index",
      input: [
        itemEvent("added", toolItem("first_index_owner", ""), 0),
        itemEvent("added", toolItem("second_index_owner", ""), 0),
      ],
      error: "Responses stream reused active tool-call output index 0",
      events: ["toolcall_start"],
    },
    {
      name: "rejects indexed Responses completions when call ids change",
      input: [
        itemEvent("added", { ...toolItem("read", "", "read"), call_id: "call_read_a" }, 0),
        argumentsDelta('{"path":"README.md"}', 0, "encrypted_delta"),
        itemEvent(
          "done",
          { ...toolItem("read_done", '{"path":"README.md"}', "read"), call_id: "call_read_b" },
          0,
        ),
        completed("resp_read"),
      ],
      error: "Responses stream changed output item identity",
      events: ["toolcall_start", "toolcall_delta"],
    },
    {
      name: "fails closed on ambiguous unindexed parallel argument events",
      input: [
        itemEvent("added", toolItem("ambiguous_first", "")),
        itemEvent("added", toolItem("ambiguous_second", "")),
        { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
        itemEvent("done", toolIdentity("ambiguous_first")),
        itemEvent("done", toolIdentity("ambiguous_second")),
        completed("resp_ambiguous_unindexed"),
      ],
      error: "Responses stream completed with unresolved tool calls",
      events: ["toolcall_start", "toolcall_start"],
    },
    {
      name: "rejects a completed Responses tool call whose function name changed",
      input: [
        itemEvent("added", toolItem("name_conflict", "", "read"), 0),
        itemEvent("done", toolItem("name_conflict", "{}", "write"), 0),
      ],
      error: "Responses stream changed tool-call function name from read to write",
      events: ["toolcall_start"],
    },
  ])("$name", async ({ input, error, events: expectedEvents }) => {
    const { done, events } = startResponses(input);
    await expect(done).rejects.toThrow(error);
    expect(eventTypes(events)).toEqual(expectedEvents);
  });

  it("ignores OAuth-sidecar decryption errors when classifying replay rejection", () => {
    const message = "Could not decrypt encrypted_content metadata for the OAuth sidecar.";
    expect(isInvalidEncryptedContentError({ message, status: 400 })).toBe(false);
  });

  it("aborts the Responses request signal when the first SSE event never arrives", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const onFirstEventTimeout = vi.fn();
      const { output, done } = startLifecycle(
        (_attempt, options) => {
          requestSignal = options.signal;
          return createNeverYieldingResponsesStream<ResponseStreamEvent>();
        },
        { options: { firstEventTimeoutMs: 5, onFirstEventTimeout } },
      );
      await vi.advanceTimersByTimeAsync(5);
      await done;
      expect(output.stopReason).toBe("error");
      expect(requestSignal?.aborted).toBe(true);
      expect(requestSignal?.reason).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(requestSignal?.reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["create", "response.failed-status", "error"] as const)(
    "recovers code-less encrypted reasoning rejected during %s stream drain",
    async (failureShape) => {
      const failureMessage =
        "400 The encrypted content [REDACTED] could not be verified. Reason: Encrypted content could not be decrypted or parsed.";
      const { output, requests, events, done } = startLifecycle(
        (attempt) => {
          if (attempt === 1 && failureShape === "create") {
            throw Object.assign(new Error(failureMessage), { status: 400 });
          }
          return streamResponsesEvents(
            attempt === 1
              ? [
                  {
                    type: "response.created",
                    sequence_number: 0,
                    response: { id: "resp_rejected" },
                  } as ResponseStreamEvent,
                  (failureShape === "response.failed-status"
                    ? {
                        type: "response.failed",
                        sequence_number: 1,
                        response: {
                          id: "resp_rejected",
                          status: "failed",
                          error: {
                            code: null,
                            status: 400,
                            message: "The encrypted content could not be decrypted or parsed.",
                          },
                        },
                      }
                    : {
                        type: "error",
                        sequence_number: 1,
                        code: null,
                        message: "400 Could not decrypt the provided encrypted_content.",
                        param: null,
                      }) as ResponseStreamEvent,
                ]
              : [{ ...completed("resp_recovered"), sequence_number: 1 } as ResponseStreamEvent],
          );
        },
        {
          buildParams: () =>
            replayRequest([
              wireReasoning("rs_replay", undefined, "stale-reasoning"),
              { type: "compaction", id: "cmp_keep", encrypted_content: "valid-compaction" },
            ]),
        },
      );
      await done;
      expect(requests).toHaveLength(2);
      expect(requests[0]?.input).toEqual(
        expect.arrayContaining([expect.objectContaining({ encrypted_content: "stale-reasoning" })]),
      );
      expect(requests[1]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reasoning", id: "rs_replay" }),
          expect.objectContaining({ type: "compaction", encrypted_content: "valid-compaction" }),
        ]),
      );
      expect(JSON.stringify(requests[1]?.input)).not.toContain("stale-reasoning");
      expect(eventTypes(events)).toEqual(["start", "done"]);
      expect(output).toMatchObject({ stopReason: "stop", responseId: "resp_recovered" });
    },
  );

  it("never retries an encrypted-looking response hook rejection", async () => {
    const onResponse = vi.fn(() => {
      throw new Error("400 The encrypted content could not be verified.");
    });
    const { output, requests, done } = startLifecycle(() => streamResponsesEvents([]), {
      options: { onResponse },
      buildParams: () => replayRequest([wireReasoning("rs_replay", undefined, "stale")]),
    });
    await done;
    expect(requests).toHaveLength(1);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(output.errorMessage).toBe("400 The encrypted content could not be verified.");
  });

  it("never retries encrypted replay after tool output starts", async () => {
    const { output, requests, events, done } = startLifecycle(
      () =>
        (async function* () {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            sequence_number: 0,
            item: toolItem("started", "", "lookup"),
          } as ResponseStreamEvent;
          throw new Error("400 The encrypted content could not be verified.");
        })(),
      {
        buildParams: () => replayRequest([wireReasoning("rs_replay", undefined, "stale")]),
      },
    );
    await done;
    expect(requests).toHaveLength(1);
    expect(output.content).toHaveLength(1);
    expect(output.stopReason).toBe("error");
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("error");
  });

  it("suppresses rejected persisted compaction state on the following turn", async () => {
    const replayIdentity = reasoningReplayIdentity;
    const prior = createAssistantOutput();
    captureOpenAIResponsesCompaction(
      prior,
      { type: "compaction", id: "cmp_rejected", encrypted_content: "opaque-rejected-compaction" },
      0,
      nativeOpenAIModel,
      buildOpenAIResponsesReasoningReplayMetadata(nativeOpenAIModel, replayIdentity),
    );
    const context: Context = {
      messages: [
        { role: "user", content: "full history prefix", timestamp: 0 },
        prior,
        { role: "user", content: "recover", timestamp: 1 },
      ],
    };
    const onPayload = vi.fn((request: unknown) => request);
    const onCompactionRejected = vi.fn();
    const { output, requests, done } = startLifecycle(
      (attempt) => {
        if (attempt === 1) {
          throw Object.assign(new Error("invalid_encrypted_content"), {
            code: "invalid_encrypted_content",
            status: 400,
          });
        }
        return streamResponsesEvents([
          {
            ...completed("resp_recovered", { output: [] }),
            sequence_number: 1,
          } as unknown as ResponseStreamEvent,
        ]);
      },
      {
        options: { ...replayIdentity, onCompactionRejected, onPayload },
        buildParams: (_model, replayMode) =>
          replayRequest(
            replayMessages(context.messages, {
              ...replayIdentity,
              replayMode,
            }),
          ),
      },
    );

    await done;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toContainEqual(
      expect.objectContaining({ type: "compaction", id: "cmp_rejected" }),
    );
    expect(JSON.stringify(requests[0]?.input)).not.toContain("full history prefix");
    const retryInput = requests[1]?.input;
    expect(Array.isArray(retryInput)).toBe(true);
    expect(retryInput).not.toContainEqual(expect.objectContaining({ type: "compaction" }));
    expect(JSON.stringify(retryInput)).toContain("full history prefix");
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
    expect(output).toMatchObject({
      stopReason: "stop",
      providerReplay: {
        type: "openai-responses-compaction-suppression",
        data: "rejected",
        provider: nativeOpenAIModel.provider,
        api: nativeOpenAIModel.api,
        model: nativeOpenAIModel.id,
      },
    });

    const nextInput = replayMessages(
      [...context.messages, output, { role: "user", content: "next turn", timestamp: 2 }],
      replayIdentity,
    );
    expect(nextInput.some((item) => item.type === "compaction")).toBe(false);
  });

  it("keeps interleaved reasoning items bound to their output indices", async () => {
    const { output, events } = await collectResponses([
      itemEvent("added", wireReasoning("rs_first"), 0),
      itemEvent("added", wireReasoning("rs_second"), 1),
      { type: "response.reasoning_text.delta", output_index: 0, delta: "first" },
      { type: "response.reasoning_text.delta", output_index: 1, delta: "second" },
      itemEvent("done", wireReasoning("rs_second", "second", "cipher-second"), 1),
      itemEvent("done", wireReasoning("rs_first", "first", "cipher-first"), 0),
      completed("resp_reasoning"),
    ]);
    expect(output.content).toMatchObject([
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
    ]);
    expect(eventPositions(events)).toBe(
      "thinking_start@0 thinking_start@1 thinking_delta@0 thinking_delta@1 thinking_end@1 thinking_end@0",
    );
    expect(
      output.content.map((block) =>
        block.type === "thinking" && block.thinkingSignature
          ? JSON.parse(block.thinkingSignature)
          : undefined,
      ),
    ).toMatchObject([
      { id: "rs_first", encrypted_content: "cipher-first" },
      { id: "rs_second", encrypted_content: "cipher-second" },
    ]);
  });

  it("keeps deferred text before an interleaved output item", async () => {
    const { output, events } = await collectResponses([
      itemEvent("added", messageItem("msg_first", ""), 0),
      itemEvent("done", messageItem("msg_first", "first"), 0),
      itemEvent("added", messageItem("msg_second", ""), 1),
      { type: "response.output_text.delta", output_index: 1, delta: "first extended" },
      itemEvent("added", wireReasoning("rs_after"), 2),
      itemEvent("done", wireReasoning("rs_after", "thought"), 2),
      itemEvent("done", messageItem("msg_second", "first extended"), 1),
      completed("resp_order"),
    ]);
    expect(output.content).toMatchObject([
      { type: "text", text: "first" },
      { type: "text", text: "first extended" },
      { type: "thinking", thinking: "thought" },
    ]);
    expect(eventPositions(events.filter((event) => event.type.endsWith("_start")))).toBe(
      "text_start@0 text_start@1 thinking_start@2",
    );
  });

  it("finalizes incomplete usage and derives an omitted token total", async () => {
    const { output } = await collectResponses([
      {
        type: "response.incomplete",
        response: {
          id: "resp_incomplete",
          status: "incomplete",
          usage: {
            input_tokens: 30,
            output_tokens: 12,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
          },
        },
      },
    ]);

    expect(output).toMatchObject({
      stopReason: "length",
      usage: { input: 22, output: 12, cacheRead: 5, cacheWrite: 3, totalTokens: 42 },
    });
  });

  it("preserves failed terminal response details and accounting", async () => {
    const model = {
      ...nativeOpenAIModel,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    } satisfies Model<"openai-responses">;
    const resolveServiceTier = vi.fn(
      (
        responseTier: ResponseCreateParamsStreaming["service_tier"],
        requestTier: ResponseCreateParamsStreaming["service_tier"],
      ) => responseTier ?? requestTier,
    );
    const applyServiceTierPricing = vi.fn(
      (usage: AssistantMessage["usage"], tier: ResponseCreateParamsStreaming["service_tier"]) => {
        if (tier === "priority") {
          usage.cost.total *= 2;
        }
      },
    );

    const { output, done } = startResponses(
      [
        {
          type: "response.failed",
          response: {
            id: "resp_failed",
            status: "failed",
            model: "gpt-5.6-luna",
            service_tier: "priority",
            error: { code: "server_error", message: "provider failed" },
            usage: {
              input_tokens: 21,
              output_tokens: 4,
              total_tokens: 25,
              input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 3 },
            },
          },
        },
      ],
      { model, options: { serviceTier: "default", resolveServiceTier, applyServiceTierPricing } },
    );
    await expect(done).rejects.toThrow("server_error: provider failed");

    expect(output).toMatchObject({
      responseId: "resp_failed",
      responseModel: "gpt-5.6-luna",
      stopReason: "stop",
      usage: {
        input: 13,
        output: 4,
        cacheRead: 6,
        cacheWrite: 2,
        reasoningTokens: 3,
        totalTokens: 25,
      },
    });
    expect(output.usage.cost).toMatchObject({
      input: expect.closeTo(0.000065, 10),
      output: expect.closeTo(0.00012, 10),
      cacheRead: expect.closeTo(0.000003, 10),
      cacheWrite: expect.closeTo(0.0000125, 10),
      total: expect.closeTo(0.000401, 10),
    });
    expect(resolveServiceTier).toHaveBeenCalledWith("priority", "default");
    expect(applyServiceTierPricing).toHaveBeenCalledWith(output.usage, "priority");
  });

  it("preserves cancellation when the SDK swallows the abort and ends iteration", async () => {
    const abort = new AbortController();
    const output = createAssistantOutput();
    async function* silentlyAbortedStream() {
      yield { type: "response.created", response: { id: "resp_aborted" } };
      abort.abort();
    }

    await expect(
      processResponsesStream(
        silentlyAbortedStream(),
        output,
        new AssistantMessageEventStream(),
        nativeOpenAIModel,
        { signal: abort.signal },
      ),
    ).rejects.toThrow("Request was aborted");
    expect(output.responseId).toBe("resp_aborted");
  });

  it("yields to aborts during bursty Responses streams without retaining partial snapshots", async () => {
    const abort = new AbortController();
    let yieldedToTimer = false;
    setTimeout(() => {
      yieldedToTimer = true;
      abort.abort();
    }, 0);

    const { events, done } = startResponses(
      [
        itemEvent("added", { type: "message" }),
        ...Array.from({ length: 512 }, () => ({ type: "response.output_text.delta", delta: "x" })),
      ],
      { model: azureModel, options: { signal: abort.signal } },
    );
    await expect(done).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(events.length).toBeLessThan(512);
    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
  });

  const fallbackArguments = (doneArguments: string | undefined) => ({
    name:
      "preserves streamed arguments when done " +
      (doneArguments === undefined ? "omits arguments" : "sends empty arguments"),
    model: nativeOpenAIModel,
    input: [
      itemEvent("added", toolItem("read", "", "read")),
      argumentsDelta('{"path":"README.md"}'),
      argumentsDone(doneArguments, 0, "fc_read"),
      itemEvent("done", toolIdentity("read", "read")),
      completed("resp_1"),
    ],
    types: ["toolcall_start", "toolcall_delta", "toolcall_end"],
  });
  it.each([
    fallbackArguments(undefined),
    fallbackArguments(""),
    {
      name: "routes indexed Responses arguments when item ids rotate",
      model: gpt56SolModel,
      input: [
        itemEvent("added", toolItem("read", "", "read"), 0),
        argumentsDelta('{"path":', 0, "encrypted_delta_1"),
        argumentsDelta('"README.md"}', 0, "encrypted_delta_2"),
        argumentsDone('{"path":"README.md"}', 0, "encrypted_done"),
        itemEvent("done", toolItem("read", "", "read"), 0),
        completed("resp_read"),
      ],
      types: ["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"],
    },
  ])("$name", async ({ model, input, types }) => {
    const { output, events } = await collectResponses(input, { model });
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([toolCall("read", "read", { path: "README.md" })]);
    expect(eventTypes(events)).toEqual(types);
  });

  it.each([true, false])(
    "adopts completed SDK identities and result linkage (call id present: %s)",
    async (hasCallId) => {
      const item = {
        type: "function_call",
        ...(hasCallId ? { call_id: "call_weather" } : {}),
        name: "weather",
        arguments: "",
        status: "in_progress",
      };
      const doneItem = {
        ...item,
        id: "fc_weather",
        call_id: "call_weather",
        arguments: '{"city":"Seattle"}',
        status: "completed",
      };
      let startedId: string | undefined;
      const { output, events } = await collectResponses(
        [
          itemEvent("added", item, 0),
          itemEvent("done", doneItem, 0),
          completed("resp_weather", { output: [doneItem] }),
        ],
        {
          model: hasCallId ? nativeOpenAIModel : azureModel,
          observe(event) {
            if (event.type === "toolcall_start") {
              const block = event.partial.content[event.contentIndex];
              startedId = block?.type === "toolCall" ? block.id : undefined;
            }
          },
        },
      );

      expect(startedId).toEqual(
        hasCallId ? "call_weather" : expect.stringMatching(/^call_[0-9a-f]{24}$/),
      );
      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toEqual([toolCall("weather", "weather", { city: "Seattle" })]);
      expect(eventPositions(events)).toBe("toolcall_start@0 toolcall_end@0");
      expect(events.at(-1)).toMatchObject({
        type: "toolcall_end",
        toolCall: { id: "call_weather|fc_weather" },
      });

      const replay = replayMessages(
        [output, makeTextToolResult("call_weather|fc_weather", "weather", "Rain", false, 1)],
        { includeSystemPrompt: false },
      );
      expect(replay).toContainEqual({
        type: "function_call",
        call_id: "call_weather",
        name: "weather",
        arguments: '{"city":"Seattle"}',
      });
      expect(replay).toContainEqual({
        type: "function_call_output",
        call_id: "call_weather",
        output: "Rain",
      });
    },
  );

  it("keeps parallel unindexed Responses calls bound by identity without orphans", async () => {
    const firstItem = { ...toolItem("first_unindexed", '{"slot":1}'), status: "completed" };
    const secondItem = { ...toolItem("second_unindexed", '{"slot":2}'), status: "completed" };

    const { output, events } = await collectResponses([
      itemEvent("added", { ...firstItem, arguments: "", status: "in_progress" }),
      itemEvent("added", { ...secondItem, arguments: "", status: "in_progress" }),
      argumentsDelta(secondItem.arguments, undefined, secondItem.id),
      argumentsDelta(firstItem.arguments, undefined, firstItem.id),
      argumentsDone(firstItem.arguments, undefined, firstItem.id),
      argumentsDone(secondItem.arguments, undefined, secondItem.id),
      itemEvent("done", firstItem),
      itemEvent("done", secondItem),
      completed("resp_parallel_unindexed", { output: [firstItem, secondItem] }),
    ]);

    const expected = [
      toolCall("first_unindexed", "computer", { slot: 1 }),
      toolCall("second_unindexed", "computer", { slot: 2 }),
    ];
    expect(output.content).toEqual(expected);
    expect(
      events
        .filter((event) => event.type === "toolcall_end")
        .map((event) => [event.contentIndex, event.toolCall]),
    ).toEqual(expected.map((call, index) => [index, call]));
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
  });

  it("recovers parallel arguments from authoritative done events and preserves opening names", async () => {
    const { output, events } = await collectResponses(createResponsesDoneArgumentEvents());

    expect(output.content).toEqual([
      toolCall("recovered_first", "read", { path: "README.md" }),
      toolCall("recovered_second", "write", { path: "README.md", text: "ok" }),
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it.each(["item-done", "terminal"])(
    "keeps provider name validation independent of consumer normalization at %s",
    async (completion) => {
      const item = toolItem("alias", '{"id":"sessions_spawn","args":{}}', "tool_call");
      const { output, events } = await collectResponses(
        [
          itemEvent("added", { ...item, arguments: "" }, 0),
          ...(completion === "item-done" ? [itemEvent("done", item, 0)] : []),
          completed("resp_alias", { output: [item] }),
        ],
        {
          observe(event) {
            // The runner normalizes aliases on the shared partial before completion.
            if ("partial" in event && event.partial) {
              for (const block of event.partial.content) {
                if (block.type === "toolCall" && block.name === "tool_call") {
                  block.name = "dispatch_action";
                }
              }
            }
          },
        },
      );
      expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
      expect(output.content).toEqual([
        toolCall("alias", "dispatch_action", { id: "sessions_spawn", args: {} }),
      ]);
    },
  );

  it.each([
    {
      name: "routes omitted-index parallel arguments and completions without duplicates",
      input: [
        itemEvent("added", toolItem("first", ""), 0),
        itemEvent("added", toolItem("second", ""), 1),
        argumentsDelta('{"slot":', 0, "fc_first"),
        argumentsDelta("0}", undefined, "fc_first"),
        argumentsDelta('{"slot":', 1),
        itemEvent("done", toolItem("second", '{"slot":1}')),
        itemEvent("done", toolItem("first", '{"slot":0}')),
        completed("resp_suffix"),
      ],
      content: [
        { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
        { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
      ],
      deltas: [0, 0, 1],
      calls: 2,
    },
    {
      name: "rejects omitted-index events whose identity mismatches the sole indexed call",
      input: [
        itemEvent("added", toolItem("first", ""), 0),
        argumentsDelta('{"wrong":true}', undefined, "fc_other"),
        itemEvent("done", toolItem("other", '{"wrong":true}')),
        itemEvent("done", toolItem("first", '{"slot":0}')),
        completed("resp_identity_mismatch"),
      ],
      content: [{ type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } }],
      deltas: [],
      calls: 1,
    },
    {
      name: "keeps sequential omitted-index Responses calls unambiguous",
      input: [
        itemEvent("added", toolItem("first", ""), 7),
        { type: "response.function_call_arguments.delta", delta: '{"slot":0}' },
        itemEvent("done", toolItem("first", '{"slot":0}')),
        itemEvent("added", toolItem("second", ""), 8),
        { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
        itemEvent("done", toolItem("second", '{"slot":1}')),
        completed("resp_sequential"),
      ],
      content: [
        { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
        { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
      ],
      deltas: [0, 1],
      calls: 2,
    },
  ])("$name", async ({ input, content, deltas, calls }) => {
    const { output, events } = await collectResponses(input);
    expect(output.content).toMatchObject(content);
    expect(
      events.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex),
    ).toEqual(deltas);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(calls);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(calls);
  });
});

const azureModel = {
  ...nativeOpenAIModel,
  api: "azure-openai-responses",
  provider: "azure",
  baseUrl: "https://test.openai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

it.each([
  { name: "explicit text part", deltaType: "response.output_text.delta", explicitPart: true },
  { name: "implicit text part", deltaType: "response.text.delta", explicitPart: false },
])("streams Azure $name", async ({ deltaType, explicitPart }) => {
  const liveTextSignatures: Array<string | undefined> = [];
  const item = { type: "message", role: "assistant", id: "msg_azure", content: [] };
  const { output, events } = await collectResponses(
    [
      itemEvent("added", { ...item, status: "in_progress" }, 0),
      ...(explicitPart
        ? [
            {
              type: "response.content_part.added",
              output_index: 0,
              part: { type: "text", text: "" },
            },
          ]
        : []),
      { type: deltaType, delta: "Hello", ...(explicitPart ? { output_index: 0 } : {}) },
      { type: deltaType, delta: " from Azure!", ...(explicitPart ? { output_index: 0 } : {}) },
      itemEvent("done", { ...item, status: "completed", content: [text("Hello from Azure!")] }, 0),
      {
        type: "response.completed",
        response: {
          id: "resp_azure",
          status: "completed",
          model: azureModel.id,
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ],
    {
      model: azureModel,
      observe(event) {
        if (event.type === "text_start" || event.type === "text_delta") {
          const block = event.partial?.content[event.contentIndex];
          liveTextSignatures.push(block?.type === "text" ? block.textSignature : undefined);
        }
      },
    },
  );
  expect(
    events.map((event) =>
      event.type === "text_delta"
        ? event.delta
        : event.type === "text_end"
          ? `[END:${event.content}]`
          : event.type,
    ),
  ).toEqual(["text_start", "Hello", " from Azure!", "[END:Hello from Azure!]"]);
  expect(output).toMatchObject({
    content: [text("Hello from Azure!")],
    usage: { input: 10, output: 5, totalTokens: 15 },
    stopReason: "stop",
  });
  expect(liveTextSignatures).toEqual([undefined, undefined, undefined]);
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
