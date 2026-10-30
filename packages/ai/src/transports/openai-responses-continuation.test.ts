import { hash } from "node:crypto";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  recordResponsesContinuationState,
  resolveResponsesContinuationRequest as resolve,
  responsesContinuationPrefixFingerprint,
  responsesContinuationRequestFingerprint,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./openai-responses-continuation.js";
import { inputMessage as userInput } from "./openai-responses-prompt-observer.test-support.js";
import { normalizeOpenAIResponsesFunctionCallId as normalizeCallId } from "./openai-responses-tool-call-id-shape.js";

type Input = NonNullable<ResponsesContinuationRequest["input"]>;
type Output = ResponsesContinuationState["lastResponseItems"];
const firstUser = userInput("first");
const secondUser = userInput("second");
const unsafeNumber = '{"n":9007199254740992}';
const unsafeString = '{"n":"9007199254740992"}';
const nestedNumber = '{"b":{"n":9007199254740993,"a":true},"a":[1]}';
const nestedString = '{"b":{"n":"9007199254740993","a":true},"a":[1]}';
const nestedWhitespace = '{ "b": {"n":9007199254740993,"a":true},"a":[1] }';
const reorderedString = '{"a":[1],"b":{"a":true,"n":"9007199254740993"}}';
const chatCallId = "chatcmpl-tool-20cf1f2fabdd434da069764b4dca72eb";
const replayedChatCallId = "call_chatcmpl-tool-20cf1f2fabdd434da069764b4dca72eb_f_3b92d47627";
const assistantOutput = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [
    {
      type: "output_text",
      text: "answer",
      annotations: [{ type: "file_citation", file_id: "file_1", filename: "a", index: 0 }],
      logprobs: [{ token: "answer", logprob: -0.1, bytes: [], top_logprobs: [] }],
    },
  ],
} satisfies ResponsesContinuationState["lastResponseItems"][number];

function continuationState(
  lastResponseItems: Output = [assistantOutput],
  input: Input = [firstUser],
): ResponsesContinuationState {
  return {
    lastRequest: {
      model: "gpt-5.6-luna",
      store: true,
      max_output_tokens: undefined,
      metadata: { stable: "yes", openclaw_turn_id: "turn-1", openclaw_turn_attempt: "1" },
      input,
    },
    lastResponseId: "resp_1",
    lastResponseItems,
  };
}

function nextRequest(phase = "final_answer", text = "answer"): ResponsesContinuationRequest {
  return {
    input: [
      firstUser,
      {
        type: "message",
        role: "assistant",
        phase,
        content: [{ type: "output_text", text, annotations: [] }],
      },
      secondUser,
    ] as never,
    metadata: { openclaw_turn_attempt: "2", openclaw_turn_id: "turn-2", stable: "yes" },
    store: true,
    model: "gpt-5.6-luna",
  };
}

function claim(params: {
  sessionId?: string;
  authorization?: string;
  turn?: string;
  request?: ResponsesContinuationRequest;
}) {
  return claimOpenAIResponsesHttpContinuation({
    sessionId: params.sessionId ?? "session-1",
    apiKey: "api-key",
    baseUrl: "https://api.openai.com/v1",
    headers: {
      Authorization: params.authorization ?? "Bearer tenant-a",
      traceparent: `trace-${params.turn ?? "1"}`,
      "x-openclaw-turn-id": `turn-${params.turn ?? "1"}`,
      "x-openclaw-turn-attempt": params.turn ?? "1",
      "x-stable-route": "route-a",
    },
    request: params.request ?? continuationState().lastRequest,
  });
}

function toolCall(
  callId: string,
  fields: Partial<ResponseFunctionToolCall> = {},
): ResponseFunctionToolCall {
  return { type: "function_call", call_id: callId, name: "exec", arguments: "{}", ...fields };
}

function toolOutput(callId: string, output = "recorded") {
  return { type: "function_call_output" as const, call_id: callId, output };
}

function commitBaseline(owner: ReturnType<typeof claim>, id: string, text?: string) {
  const { lastRequest, lastResponseItems } = continuationState();
  const output =
    text === undefined
      ? lastResponseItems
      : [
          {
            ...assistantOutput,
            content: [{ type: "output_text" as const, text, annotations: [], logprobs: [] }],
          },
        ];
  owner?.commit(lastRequest, { id, output });
}

function replayRequest(state: ResponsesContinuationState, ...input: Input) {
  return { ...state.lastRequest, input: [firstUser, ...input] };
}

function previousResponseId(sessionId = "session-1", text = "answer") {
  const next = claim({ sessionId, request: nextRequest("final_answer", text) });
  const id = next?.request.previous_response_id;
  next?.release();
  return id;
}
function record(
  previous: ResponsesContinuationState | undefined,
  input: Input,
  id: string,
  output: Output,
  continued = false,
) {
  return recordResponsesContinuationState(previous, { input }, { id, output }, continued);
}

function expectHistoryChanged(
  state: ResponsesContinuationState,
  request: ResponsesContinuationRequest,
) {
  expect(resolve(state, request)).toEqual({
    continuationStatus: "history_changed",
    request,
  });
}

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

describe("OpenAI Responses continuation", () => {
  it("preserves persisted request and prefix hashes across JSON normalization and key order", () => {
    const text = `${"x".repeat(17_000)}🦞 café e\u0301 \ud800\n`;
    const encodedText = JSON.stringify(text);
    const toJSON = vi.fn(() => ({ z: true, omitted: undefined, text, a: Infinity }));
    const request = {
      store: true,
      provider_options: { toJSON },
      model: "fixture-model",
      metadata: { openclaw_turn_id: "turn-1", stable: "yes", openclaw_turn_attempt: "1" },
      input: [firstUser],
      tools: [],
      instructions: "current instructions",
      previous_response_id: "resp_previous",
      omitted: undefined,
    };
    const requestHash = hash(
      "sha256",
      `{"metadata":{"stable":"yes"},"model":"fixture-model","provider_options":{"a":null,"text":${encodedText},"z":true},"store":true}`,
    );
    expect(responsesContinuationRequestFingerprint(request)).toBe(requestHash);
    expect(toJSON).toHaveBeenCalledOnce();
    expect(
      responsesContinuationRequestFingerprint({
        model: "fixture-model",
        metadata: { stable: "yes" },
        provider_options: { a: null, text, z: true },
        store: true,
      }),
    ).toBe(requestHash);
    expect(responsesContinuationRequestFingerprint({ ...request, store: false })).not.toBe(
      requestHash,
    );

    const content = vi.fn(() => [{ type: "input_text", text, omitted: undefined }]);
    const input = [{ type: "message", role: "user", content: { toJSON: content } }];
    const prefixHash = hash(
      "sha256",
      `[{"content":[{"text":${encodedText},"type":"input_text"}],"role":"user","type":"message"},{"content":[{"text":"answer","type":"output_text"}],"phase":"final_answer","role":"assistant","type":"message"}]`,
    );
    expect(responsesContinuationPrefixFingerprint(input, [assistantOutput])).toBe(prefixHash);
    expect(content).toHaveBeenCalledOnce();
    expect(
      responsesContinuationPrefixFingerprint([
        { content: [{ text, type: "input_text" }], role: "user", type: "message" },
        assistantOutput,
      ]),
    ).toBe(prefixHash);
    expect(
      responsesContinuationPrefixFingerprint([userInput(`${text}changed`)], [assistantOutput]),
    ).not.toBe(prefixHash);
  });

  it("fingerprints mutable history without serializing the whole prefix", () => {
    const text = "history payload".repeat(2_000);
    const content = { type: "input_text", text };
    const item = { type: "message", role: "user", content: [content] };
    const input = [item];
    const encodedText = JSON.stringify(text);
    const expected = hash(
      "sha256",
      `[{"content":[{"text":${encodedText},"type":"input_text"}],"role":"user","type":"message"}]`,
    );
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(responsesContinuationPrefixFingerprint(input)).toBe(expected);
      // The canonical writer encodes string leaves; no container needs another JSON encoding.
      expect(
        stringify.mock.calls.filter(([value]) => value !== null && typeof value === "object"),
      ).toHaveLength(0);
      content.text = `${text} edited`;
      expect(responsesContinuationPrefixFingerprint(input)).not.toBe(expected);
    } finally {
      stringify.mockRestore();
    }
  });

  it("compares mutable continuation history without materializing property-entry arrays", () => {
    const previousMessage = userInput("message 0");
    const currentMessage = structuredClone(previousMessage);
    const input = [
      previousMessage,
      ...Array.from({ length: 63 }, (_, index) => userInput(`message ${index + 1}`)),
    ];
    const state: ResponsesContinuationState = {
      lastRequest: { input },
      lastResponseId: "resp_previous",
      lastResponseItems: [],
    };
    const current = [currentMessage, ...structuredClone(input.slice(1))];
    const request = { input: [...current, secondUser] };
    const fromEntries = vi.spyOn(Object, "fromEntries");
    try {
      expect(resolve(state, request)).toMatchObject({
        continuationStatus: "continued",
        request: { previous_response_id: "resp_previous", input: [secondUser] },
      });
      expect(fromEntries).not.toHaveBeenCalled();
      currentMessage.content[0] = { type: "input_text", text: "edited in place" };
      expectHistoryChanged(state, request);
      previousMessage.content[0] = { type: "input_text", text: "edited in place" };
      expect(resolve(state, request).continuationStatus).toBe("continued");
    } finally {
      fromEntries.mockRestore();
    }
  });

  it.each([
    {
      name: "omitted fields, sparse arrays, nonfinite numbers and signed zero",
      // oxlint-disable-next-line no-sparse-arrays -- A genuine array hole must compare as JSON null.
      value: { omit: undefined, values: [, undefined, Number.NaN, Infinity, -0], text: "🦞\ud800" },
      expected: { values: [null, null, null, null, 0], text: "🦞\ud800" },
    },
    {
      name: "built-in serializers",
      value: {
        at: new Date("2026-01-01Z"),
        url: new URL("https://example.test/"),
        data: Buffer.from([1, 2]),
      },
      expected: {
        at: "2026-01-01T00:00:00.000Z",
        url: "https://example.test/",
        data: { type: "Buffer", data: [1, 2] },
      },
    },
    {
      name: "key-sensitive serializers on objects and functions",
      value: {
        nested: { toJSON: (key: string) => ({ key }) },
        array: [Object.assign(() => {}, { toJSON: (key: string) => key })],
      },
      expected: { nested: { key: "nested" }, array: ["0"] },
    },
    {
      name: "own __proto__ fields and null-prototype objects",
      value: Object.assign(
        Object.create(null),
        JSON.parse('{"__proto__":{"own":true},"omit":null}'),
      ),
      expected: JSON.parse('{"omit":null,"__proto__":{"own":true}}'),
    },
    {
      name: "proxy serializers",
      value: new Proxy(
        { text: "plain" },
        {
          get: (target, key) =>
            key === "toJSON" ? () => ({ text: "wire" }) : Reflect.get(target, key),
        },
      ),
      expected: { text: "wire" },
    },
  ])("compares continuation envelopes using JSON semantics: $name", ({ value, expected }) => {
    const state = continuationState();
    state.lastRequest.provider_options = expected;
    const request = { ...nextRequest(), provider_options: value };
    expect(resolve(state, request).continuationStatus).toBe("continued");
    state.lastRequest.provider_options = { changed: true };
    expect(resolve(state, request).continuationStatus).toBe("request_changed");
  });

  it("rejects unserializable history without retaining a failed comparison", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const state = continuationState();
    for (const value of [cycle, 1n]) {
      expect(() => resolve(state, { ...nextRequest(), provider_options: value })).toThrow(
        TypeError,
      );
    }
    expect(resolve(state, nextRequest()).continuationStatus).toBe("continued");
  });

  it("matches JSON wire semantics and provider-only assistant replay metadata", () => {
    const continued = resolve(continuationState(), nextRequest());
    expect(continued).toMatchObject({
      continuationStatus: "continued",
      request: { previous_response_id: "resp_1", input: [secondUser] },
    });
    expect(resolve(continuationState(), nextRequest("commentary")).continuationStatus).toBe(
      "history_changed",
    );
    const explicit = { ...nextRequest(), previous_response_id: "resp_explicit" };
    expect(resolve(continuationState(), explicit)).toEqual({
      request: explicit,
      continuationStatus: "explicit_previous_response_id",
    });
  });

  it("continues across user turns when runtime context stays before the prior tool round", () => {
    const state = continuationState();
    const carrier = (text: string) =>
      userInput(
        `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${text}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
      );
    const firstCarrier = carrier("first turn metadata");
    state.lastRequest.input = [
      ...(state.lastRequest.input ?? []),
      firstCarrier,
      toolCall("call_1", { name: "lookup" }),
      toolOutput("call_1", "lookup result"),
    ];
    const nextTurn = [secondUser, carrier("second turn metadata")] satisfies Input;
    const request = {
      ...state.lastRequest,
      input: [...(state.lastRequest.input ?? []), assistantOutput, ...nextTurn],
    };
    expect(resolve(state, request)).toMatchObject({
      continuationStatus: "continued",
      request: { previous_response_id: "resp_1", input: nextTurn },
    });
    const withoutPreviousCarrier = {
      ...request,
      input: request.input?.filter((item) => item !== firstCarrier),
    };
    expectHistoryChanged(state, withoutPreviousCarrier);
  });

  it("keeps current tools while continuing unchanged history", () => {
    const tools = (name: string) => ({
      tools: [{ type: "function", name, parameters: { type: "object" } }],
    });
    const state = continuationState();
    state.lastRequest = { ...state.lastRequest, ...tools("read") };
    const current = tools("write");
    const request = { ...nextRequest(), ...current };
    const before = structuredClone({ state, request });
    const resolved = resolve(state, request);
    expect(resolved).toMatchObject({
      continuationStatus: "continued",
      request: { ...current, previous_response_id: "resp_1", input: [secondUser] },
    });
    expect({ state, request }).toEqual(before);
  });

  it.each([
    ["nested whitespace", nestedWhitespace, nestedString, "continued"],
    ["reordered keys", nestedNumber, reorderedString, "history_changed"],
    ["binary64 collision", unsafeNumber, '{"n":9007199254740993}', "history_changed"],
    ["unsafe string to integer", unsafeString, unsafeNumber, "history_changed"],
    ["unchanged incomplete JSON", '{"n":', '{"n":', "continued"],
    ["changed incomplete JSON", '{"n":', '{"n": }', "history_changed"],
    ["non-object array", "[42]", "[42.0]", "history_changed"],
    ["safe fraction", '{"n":4.20}', '{"n":4.2}', "continued"],
  ] as const)(
    "compares admitted provider tool arguments: %s",
    (_name, rawArguments, replayedArguments, expectedStatus) => {
      const call = toolCall("call_1", {
        id: "fc_1",
        status: "completed" as const,
        name: "record_value",
        arguments: rawArguments,
      });
      const state = continuationState([call]);
      const output = toolOutput("call_1");
      const request = replayRequest(state, { ...call, arguments: replayedArguments }, output);
      const before = structuredClone({ state, request });
      const resolved = resolve(state, request);
      expect(resolved.continuationStatus).toBe(expectedStatus);
      if (expectedStatus === "continued") {
        expect(resolved.request).toMatchObject({ previous_response_id: "resp_1", input: [output] });
      } else {
        expect(resolved.request).toBe(request);
      }
      expect({ state, request }).toEqual(before);
    },
  );

  it.each([
    [unsafeNumber, unsafeString, "history_changed"],
    [unsafeNumber, unsafeNumber, "continued"],
  ] as const)("keeps already-sent arguments strict: %s -> %s", (sent, current, expectedStatus) => {
    const state = continuationState();
    const call = toolCall("sent_call", { name: "record_value", arguments: sent });
    const output = toolOutput("sent_call");
    state.lastRequest.input = [...(state.lastRequest.input ?? []), call, output];
    const request = nextRequest();
    request.input = [
      firstUser,
      { ...call, arguments: current },
      output,
      ...(request.input ?? []).slice(1),
    ];
    const before = structuredClone({ state, request });
    const resolved = resolve(state, request);
    expect(resolved.continuationStatus).toBe(expectedStatus);
    if (expectedStatus === "history_changed") {
      expect(resolved.request).toBe(request);
    }
    expect({ state, request }).toEqual(before);
  });

  it.each([
    ["paired reshape", chatCallId, "fc_1", replayedChatCallId, true],
    ["unchanged pair", "functions.gateway:0", "fc_tmp_kegospxl46", "functions.gateway:0", true],
    ["omitted item ID", "functions.gateway:0", "fc_tmp_kegospxl46", "functions.gateway:0", false],
    [
      "bare reshape",
      "functions.gateway:0",
      "fc_tmp_kegospxl46",
      normalizeCallId("functions.gateway:0"),
      false,
    ],
  ] as const)(
    "restores the provider call ID after %s replay",
    (_name, rawId, itemId, replayId, keepItemId) => {
      const call = toolCall(rawId, {
        id: itemId,
        status: "completed",
        arguments: '{"command":"echo hi"}',
      });
      const state = continuationState([{ type: "reasoning" }, call] as never);
      const { id: _id, ...bareCall } = call;
      const request: ResponsesContinuationRequest = {
        ...state.lastRequest,
        input: [
          firstUser,
          { type: "reasoning" },
          { ...bareCall, ...(keepItemId ? { id: itemId } : {}), call_id: replayId },
          toolOutput(replayId, "hi\n"),
        ] as never,
      };
      expect(resolve(state, request)).toMatchObject({
        continuationStatus: "continued",
        request: { previous_response_id: "resp_1", input: [toolOutput(rawId, "hi\n")] },
      });
    },
  );

  it.each([
    ["id", "fc_output_changed", "history_changed"],
    ["call_id", normalizeCallId("functions.gateway:0"), "continued"],
  ] as const)("compares prior output %s independently of its item ID", (field, value, expected) => {
    const output = { ...toolOutput("functions.gateway:0"), id: "fc_output_1", status: "completed" };
    const state = continuationState();
    state.lastRequest.input = [firstUser, output] as never;
    const request = nextRequest();
    request.input = [
      firstUser,
      { ...output, [field]: value },
      ...(request.input ?? []).slice(1),
    ] as never;
    expect(resolve(state, request).continuationStatus).toBe(expected);
  });

  it.each([
    [false, "unrelated", "call_original_abc", "call_unrelated_xyz", "call_unrelated_xyz"],
    [false, "colliding call", " x", "x", "x"],
    [false, "colliding result", " x", " x", "x"],
    [true, "unrelated", "call_a", "call_b", "call_b"],
    [true, "colliding call", " x", "x", "x"],
    [true, "colliding result", " x", " x", "x"],
  ] as const)(
    "rejects unowned IDs (earlier=%s, %s)",
    (earlier, _name, rawId, replayId, outputId) => {
      const call = toolCall(
        rawId,
        earlier ? { name: "lookup" } : { id: "fc_1", status: "completed" },
      );
      const state = continuationState();
      if (earlier) {
        state.lastRequest.input = [firstUser, call, toolOutput(rawId)] as never;
      } else {
        state.lastResponseItems = [call];
      }
      const request = replayRequest(
        state,
        { ...call, call_id: replayId },
        toolOutput(outputId),
        ...(earlier ? [assistantOutput, secondUser] : []),
      );
      expectHistoryChanged(state, request);
    },
  );
  it("rejects a changed earlier tool result when IDs share a replay shape", () => {
    const canonicalCallId = normalizeCallId(" x");
    const first = toolCall(canonicalCallId, { name: "first" });
    const second = toolCall(" x", { name: "second" });
    const originalOutput = toolOutput(canonicalCallId);
    const state = continuationState(undefined, [firstUser, first, second, originalOutput]);
    const changed = { ...originalOutput, call_id: " x" };
    const request = replayRequest(state, first, second, changed, assistantOutput, secondUser);
    expectHistoryChanged(state, request);
  });

  it("retains pending calls when a result matches a colliding replay shape", () => {
    const canonicalCallId = normalizeCallId(" x");
    const calls = [toolCall(" x", { name: "async" }), toolCall(canonicalCallId, { name: "sync" })];
    const first = record(undefined, [firstUser, ...calls], "resp_1", calls);
    const second = record(
      first,
      [firstUser, ...calls, toolOutput(canonicalCallId, "sync result")],
      "resp_2",
      [assistantOutput],
      true,
    );
    expect(second.pendingToolCalls).toEqual([{ callId: " x" }, { callId: canonicalCallId }]);
  });

  it("does not let an older result resolve a newer call that reuses its ID", () => {
    const reusedCall = toolCall("call_reused", { name: "lookup" });
    const oldInput = [firstUser, reusedCall, toolOutput("call_reused", "old result")];
    const previous = {
      lastRequest: { input: oldInput },
      lastResponseId: "resp_1",
      lastResponseItems: [reusedCall],
    };
    const current = record(previous, [...oldInput, reusedCall], "resp_2", [assistantOutput], true);
    expect(current.pendingToolCalls).toEqual([{ callId: "call_reused" }]);
  });

  it("rebuilds pending call IDs from a full-history fallback", () => {
    const rawCall = toolCall(" x", { name: "async" });
    const replayedCallId = normalizeCallId(rawCall.call_id);
    const previous = record(undefined, [firstUser], "resp_1", [rawCall]);
    const fallback = record(
      previous,
      [firstUser, { ...rawCall, call_id: replayedCallId }],
      "resp_2",
      [assistantOutput],
      false,
    );
    expect(fallback.pendingToolCalls).toEqual([{ callId: replayedCallId }]);
  });

  it("keeps raw async call IDs when HTTP commits the full baseline of a continuation", () => {
    const rawCall = toolCall(" x", { name: "async" });
    const replayedCall = {
      ...rawCall,
      call_id: normalizeCallId(rawCall.call_id),
    };
    const firstRequest = continuationState().lastRequest;
    claim({ request: firstRequest })?.commit(firstRequest, {
      id: "resp_1",
      output: [rawCall] as never,
    });
    const secondRequest: ResponsesContinuationRequest = {
      ...firstRequest,
      input: [firstUser, replayedCall] as never,
    };
    const second = claim({ request: secondRequest });
    expect(second?.request.previous_response_id).toBe("resp_1");
    second?.commit(secondRequest, { id: "resp_2", output: [assistantOutput] }, "resp_1");
    const toolResult = toolOutput(replayedCall.call_id, "lookup result");
    const third = claim({
      request: {
        ...firstRequest,
        input: [firstUser, replayedCall, assistantOutput, toolResult] as never,
      },
    });
    expect(third?.request.previous_response_id).toBe("resp_2");
    expect(third?.request.input).toEqual([{ ...toolResult, call_id: rawCall.call_id }]);
    third?.release();
  });

  it("rejects ambiguous restoration when distinct cached calls share a bare replay shape", () => {
    const cachedCalls = [
      toolCall(" x", { id: "fc_1", name: "first" }),
      toolCall("x", { id: "fc_2", name: "second" }),
    ];
    const bareReplayCallId = normalizeCallId(" x");
    const state = continuationState(cachedCalls);
    const request = replayRequest(
      state,
      toolCall(bareReplayCallId, { name: "first" }),
      toolCall(bareReplayCallId, { name: "second" }),
      toolOutput(bareReplayCallId),
    );
    expectHistoryChanged(state, request);
  });

  it("ignores turn correlation headers but isolates explicit authorization", () => {
    const first = claim({ turn: "1" });
    commitBaseline(first, "resp_1");
    const sameTenant = claim({ turn: "2", request: nextRequest() });
    expect(sameTenant?.request.previous_response_id).toBe("resp_1");
    sameTenant?.commit(nextRequest(), { id: "resp_2", output: [] }, "resp_1");
    const rotated = claim({ turn: "3", authorization: "Bearer tenant-b", request: nextRequest() });
    expect(rotated?.request.previous_response_id).toBeUndefined();
    rotated?.release();
  });

  it("grants one claim and prevents a concurrent non-owner from overwriting it", () => {
    const owner = claim({});
    expect(claim({})).toBeUndefined();
    commitBaseline(owner, "resp_owner");
    expect(claim({ request: nextRequest() })?.request.previous_response_id).toBe("resp_owner");
  });

  it("prevents cleanup-time claims from resurrecting session state", () => {
    const stale = claim({});
    cleanupSessionResources("session-1");
    commitBaseline(stale, "resp_stale");
    expect(previousResponseId()).toBeUndefined();
  });
});

describe("OpenAI Responses continuation cache bounds", () => {
  const capacity = 1000;
  const byteBudget = 64 * 1024 * 1024;
  function commit(sessionId: string, responseId: string, text = "answer") {
    commitBaseline(claim({ sessionId }), responseId, text);
  }

  it.each([
    [89 * 60 * 1000, "resp_cached"],
    [90 * 60 * 1000 + 1, undefined],
  ] as const)("bounds idle retention at 90 minutes (elapsed=%s)", (elapsed, expected) => {
    vi.useFakeTimers();
    commit("session-1", "resp_cached");
    vi.advanceTimersByTime(elapsed);
    expect(previousResponseId("session-1")).toBe(expected);
  });

  it.each([
    { bound: "entry count", count: capacity, bytes: 0, reclaim: false },
    { bound: "commit order after reclaim", count: capacity, bytes: 0, reclaim: true },
    { bound: "aggregate bytes", count: 4, bytes: Math.floor(byteBudget / 5), reclaim: false },
  ])("evicts the oldest committed baseline at the $bound limit", ({ count, bytes, reclaim }) => {
    vi.useFakeTimers();
    const text = bytes ? "x".repeat(bytes) : "answer";
    for (let i = 0; i < count; i++) {
      commit(`session-${i}`, `resp-${i}`, text);
    }
    if (reclaim) {
      const oldest = claim({ sessionId: "session-0", request: nextRequest() });
      expect(oldest?.request.previous_response_id).toBe("resp-0");
      oldest?.commit(continuationState().lastRequest, {
        id: "resp-refreshed",
        output: [assistantOutput],
      });
    }
    commit("session-overflow", "resp-overflow", text);
    expect(previousResponseId(`session-${reclaim ? 1 : 0}`, text)).toBeUndefined();
    expect(previousResponseId(`session-${reclaim ? 0 : count - 1}`, text)).toBe(
      reclaim ? "resp-refreshed" : `resp-${count - 1}`,
    );
  });

  it("skips an oversized entry without evicting a neighbor or leaving its claim stuck", () => {
    commit("neighbor", "resp_neighbor");
    const text = "x".repeat(byteBudget + 1);
    commit("session-1", "resp_oversized", text);
    const afterOversized = claim({ request: nextRequest("final_answer", text) });
    expect(afterOversized?.request.previous_response_id).toBeUndefined();
    expect(previousResponseId("neighbor")).toBe("resp_neighbor");
    afterOversized?.commit(continuationState().lastRequest, {
      id: "resp_normal",
      output: [assistantOutput],
    });
    expect(previousResponseId("session-1")).toBe("resp_normal");
  });
});
