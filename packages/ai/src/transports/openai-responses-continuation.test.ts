import { hash } from "node:crypto";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  recordResponsesContinuationState,
  resolveResponsesContinuationRequest as resolve,
  responsesContinuationPrefixFingerprint as fingerprintPrefix,
  responsesContinuationRequestFingerprint as fingerprintRequest,
  type ResponsesContinuationRequest as Request,
  type ResponsesContinuationState as Continuation,
} from "./openai-responses-continuation.js";
import {
  inputMessage as userInput,
  outputMessage,
} from "./openai-responses-prompt-observer.test-support.js";
import { normalizeOpenAIResponsesFunctionCallId as normalizeCallId } from "./openai-responses-tool-call-id-shape.js";

type Input = NonNullable<Request["input"]>;
type Output = Continuation["lastResponseItems"];
const firstUser = userInput("first");
const secondUser = userInput("second");
const unsafeNumber = '{"n":9007199254740992}';
const unsafeString = '{"n":"9007199254740992"}';
const nestedNumber = '{"b":{"n":9007199254740993,"a":true},"a":[1]}';
const nestedString = '{"b":{"n":"9007199254740993","a":true},"a":[1]}';
const nestedWhitespace = '{ "b": {"n":9007199254740993,"a":true},"a":[1] }';
const reorderedString = '{"a":[1],"b":{"a":true,"n":"9007199254740993"}}';
const gatewayCallId = "functions.gateway:0";
const gatewayItemId = "fc_tmp_kegospxl46";
const assistantOutput = {
  ...outputMessage("answer", "msg_1"),
  phase: "final_answer",
  content: [
    {
      type: "output_text",
      text: "answer",
      annotations: [
        {
          type: "url_citation",
          url: "https://example.test/source",
          title: "source",
          start_index: 0,
          end_index: 6,
        },
      ],
      logprobs: [{ token: "answer", logprob: -0.1, bytes: [], top_logprobs: [] }],
    },
  ],
} satisfies Continuation["lastResponseItems"][number];

function continuationState(
  lastResponseItems: Output = [assistantOutput],
  input: Input = [firstUser],
): Continuation {
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

function nextRequest(phase = "final_answer", text = "answer"): Request {
  return {
    ...continuationState().lastRequest,
    input: [firstUser, { ...outputMessage(text), phase }, secondUser] as never,
    metadata: { openclaw_turn_attempt: "2", openclaw_turn_id: "turn-2", stable: "yes" },
  };
}

function claim(params: {
  sessionId?: string;
  authorization?: string;
  turn?: string;
  request?: Request;
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

function commitBaseline(owner: ReturnType<typeof claim>, id: string, text = "answer") {
  owner?.commit(continuationState().lastRequest, {
    id,
    output: [{ ...outputMessage(text), phase: "final_answer" }],
  });
}

function replayRequest(state: Continuation, ...input: Input) {
  return { ...state.lastRequest, input: [firstUser, ...input] };
}

function previousResponseId(sessionId = "session-1", text = "answer") {
  const next = claim({ sessionId, request: nextRequest("final_answer", text) });
  const id = next?.request.previous_response_id;
  next?.release();
  return id;
}
function record(
  previous: Continuation | undefined,
  input: Input,
  id: string,
  output: Output,
  continued = false,
) {
  return recordResponsesContinuationState(previous, { input }, { id, output }, continued);
}

function expectHistoryChanged(state: Continuation, request: Request) {
  expect(resolve(state, request)).toEqual({ continuationStatus: "history_changed", request });
}

function expectContinuation(state: Continuation, request: Request, input: Input) {
  expect(resolve(state, request)).toMatchObject({
    continuationStatus: "continued",
    request: { previous_response_id: "resp_1", input },
  });
}

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

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
  const canonicalRequest = {
    metadata: { stable: "yes" },
    model: "fixture-model",
    provider_options: { a: null, text, z: true },
    store: true,
  };
  const requestHash = hash("sha256", JSON.stringify(canonicalRequest));
  expect(fingerprintRequest(request)).toBe(requestHash);
  expect(toJSON).toHaveBeenCalledOnce();
  expect(fingerprintRequest(canonicalRequest)).toBe(requestHash);
  expect(fingerprintRequest({ ...request, store: false })).not.toBe(requestHash);

  const content = vi.fn(() => [{ type: "input_text", text, omitted: undefined }]);
  const input = [{ type: "message", role: "user", content: { toJSON: content } }];
  const prefixHash = hash(
    "sha256",
    `[{"content":[{"text":${encodedText},"type":"input_text"}],"role":"user","type":"message"},{"content":[{"text":"answer","type":"output_text"}],"phase":"final_answer","role":"assistant","type":"message"}]`,
  );
  expect(fingerprintPrefix(input, [assistantOutput])).toBe(prefixHash);
  expect(content).toHaveBeenCalledOnce();
  expect(
    fingerprintPrefix([
      { content: [{ text, type: "input_text" }], role: "user", type: "message" },
      assistantOutput,
    ]),
  ).toBe(prefixHash);
  expect(fingerprintPrefix([userInput(`${text}changed`)], [assistantOutput])).not.toBe(prefixHash);
});

it.each([
  [
    "omitted fields, sparse arrays, nonfinite numbers and signed zero",
    // oxlint-disable-next-line no-sparse-arrays -- A genuine array hole must compare as JSON null.
    { omit: undefined, values: [, undefined, Number.NaN, Infinity, -0], text: "🦞\ud800" },
    { values: [null, null, null, null, 0], text: "🦞\ud800" },
  ],
  ["built-in serializer", { at: new Date(0) }, { at: "1970-01-01T00:00:00.000Z" }],
  [
    "key-sensitive serializers on objects and functions",
    {
      nested: { toJSON: (key: string) => ({ key }) },
      array: [Object.assign(() => {}, { toJSON: (key: string) => key })],
    },
    { nested: { key: "nested" }, array: ["0"] },
  ],
  [
    "own __proto__ fields and null-prototype objects",
    Object.assign(Object.create(null), JSON.parse('{"__proto__":{"own":true},"omit":null}')),
    JSON.parse('{"omit":null,"__proto__":{"own":true}}'),
  ],
  [
    "proxy serializers",
    new Proxy(
      { text: "plain" },
      {
        get: (target, key) =>
          key === "toJSON" ? () => ({ text: "wire" }) : Reflect.get(target, key),
      },
    ),
    { text: "wire" },
  ],
])("compares continuation envelopes using JSON semantics: %s", (_name, value, expected) => {
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
    expect(() => resolve(state, { ...nextRequest(), provider_options: value })).toThrow(TypeError);
  }
  expect(resolve(state, nextRequest()).continuationStatus).toBe("continued");
});

it("matches JSON wire semantics and provider-only assistant replay metadata", () => {
  expectContinuation(continuationState(), nextRequest(), [secondUser]);
  expect(resolve(continuationState(), nextRequest("commentary")).continuationStatus).toBe(
    "history_changed",
  );
  const explicit = { ...nextRequest(), previous_response_id: "resp_explicit" };
  expect(resolve(continuationState(), explicit)).toEqual({
    request: explicit,
    continuationStatus: "explicit_previous_response_id",
  });
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
      arguments: rawArguments,
    });
    const state = continuationState([call]);
    const output = toolOutput("call_1");
    const request = replayRequest(state, { ...call, arguments: replayedArguments }, output);
    const resolved = resolve(state, request);
    expect(resolved.continuationStatus).toBe(expectedStatus);
    if (expectedStatus === "continued") {
      expect(resolved.request).toMatchObject({ previous_response_id: "resp_1", input: [output] });
    } else {
      expect(resolved.request).toBe(request);
    }
  },
);

it.each([gatewayCallId, normalizeCallId(gatewayCallId)])(
  "restores %s without an item ID",
  (replayId) => {
    const call = toolCall(gatewayCallId, { id: gatewayItemId, status: "completed" });
    const reasoning = { type: "reasoning", id: "rs_1", summary: [] } satisfies Output[number];
    const state = continuationState([reasoning, call]);
    const { id: _id, ...bareCall } = call;
    const request = replayRequest(
      state,
      reasoning,
      { ...bareCall, call_id: replayId },
      toolOutput(replayId),
    );
    expectContinuation(state, request, [toolOutput(gatewayCallId)]);
  },
);

it.each([
  ["id", "fc_output_changed", "history_changed"],
  ["call_id", normalizeCallId("functions.gateway:0"), "continued"],
] as const)("compares prior output %s independently of its item ID", (field, value, expected) => {
  const output = { ...toolOutput("functions.gateway:0"), id: "fc_output_1", status: "completed" };
  const state = continuationState(undefined, [firstUser, output]);
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
] as const)("rejects unowned IDs (earlier=%s, %s)", (earlier, _name, rawId, replayId, outputId) => {
  const call = toolCall(rawId, earlier ? { name: "lookup" } : { id: "fc_1", status: "completed" });
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
});
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
  const previous = continuationState([reusedCall], oldInput);
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
  const secondRequest: Request = {
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
