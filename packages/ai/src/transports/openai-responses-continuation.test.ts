import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiTransportHost, runWithAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  recordResponsesContinuationState,
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./openai-responses-continuation.js";
import { normalizeOpenAIResponsesFunctionCallId } from "./openai-responses-tool-call-id-shape.js";

const userInput = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const firstUser = userInput("first");
const secondUser = userInput("second");
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
} satisfies ResponsesContinuationState["lastResponseItems"][number];

function continuationState(): ResponsesContinuationState {
  return {
    lastRequest: {
      model: "gpt-5.6-luna",
      store: true,
      max_output_tokens: undefined,
      metadata: { stable: "yes", openclaw_turn_id: "turn-1", openclaw_turn_attempt: "1" },
      input: [firstUser] as never,
    },
    lastResponseId: "resp_1",
    lastResponseItems: [assistantOutput],
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

function commitBaseline(owner: ReturnType<typeof claim>, id: string) {
  const { lastRequest, lastResponseItems } = continuationState();
  owner?.commit(lastRequest, { id, output: lastResponseItems });
}

function replayRequest(
  state: ResponsesContinuationState,
  input: unknown[],
): ResponsesContinuationRequest {
  return { ...state.lastRequest, input: input as never };
}

function expectHistoryChanged(
  state: ResponsesContinuationState,
  request: ResponsesContinuationRequest,
) {
  expect(resolveResponsesContinuationRequest(state, request)).toEqual({
    continuationStatus: "history_changed",
    request,
  });
}

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

describe("OpenAI Responses continuation", () => {
  it("matches JSON wire semantics and provider-only assistant replay metadata", () => {
    const continued = resolveResponsesContinuationRequest(continuationState(), nextRequest());
    expect(continued).toMatchObject({
      continuationStatus: "continued",
      request: {
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second" }],
          },
        ],
      },
    });

    expect(
      resolveResponsesContinuationRequest(continuationState(), nextRequest("commentary"))
        .continuationStatus,
    ).toBe("history_changed");
    const explicit = { ...nextRequest(), previous_response_id: "resp_explicit" };
    expect(resolveResponsesContinuationRequest(continuationState(), explicit)).toEqual({
      request: explicit,
      continuationStatus: "explicit_previous_response_id",
    });
  });

  it("continues across user turns when runtime context stays before the prior tool round", () => {
    const state = continuationState();
    const carrier = (text: string) => ({
      type: "message" as const,
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${text}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
        },
      ],
    });
    const firstCarrier = carrier("first turn metadata");
    state.lastRequest.input = [
      ...(state.lastRequest.input ?? []),
      firstCarrier,
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "lookup result" },
    ];
    const nextTurn = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
      carrier("second turn metadata"),
    ] satisfies NonNullable<ResponsesContinuationRequest["input"]>;
    const request: ResponsesContinuationRequest = {
      ...state.lastRequest,
      input: [...(state.lastRequest.input ?? []), assistantOutput, ...nextTurn],
    };

    expect(resolveResponsesContinuationRequest(state, request)).toMatchObject({
      continuationStatus: "continued",
      request: { previous_response_id: "resp_1", input: nextTurn },
    });
    const withoutPreviousCarrier = {
      ...request,
      input: request.input?.filter((item) => item !== firstCarrier),
    };
    expect(resolveResponsesContinuationRequest(state, withoutPreviousCarrier)).toEqual({
      continuationStatus: "history_changed",
      request: withoutPreviousCarrier,
    });
  });

  it.each([
    {
      name: "tools",
      previous: { tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      current: { tools: [{ type: "function", name: "write", parameters: { type: "object" } }] },
    },
  ])("keeps current $name while continuing unchanged history", ({ previous, current }) => {
    const state = continuationState();
    state.lastRequest = { ...state.lastRequest, ...previous };
    const request = { ...nextRequest(), ...current };
    const before = structuredClone({ state, request });

    const resolved = resolveResponsesContinuationRequest(state, request);

    expect(resolved.continuationStatus).toBe("continued");
    expect(resolved.request).toMatchObject({ ...current, previous_response_id: "resp_1" });
    expect(resolved.request.input).toHaveLength(1);
    expect({ state, request }).toEqual(before);
  });

  it.each([
    [
      "provider whitespace in nested arguments",
      '{ "b": {"n":9007199254740993,"a":true},"a":[1] }',
      '{"b":{"n":"9007199254740993","a":true},"a":[1]}',
      "continued",
    ],
    [
      "reordered keys remain conservative",
      '{"b":{"n":9007199254740993,"a":true},"a":[1]}',
      '{"a":[1],"b":{"a":true,"n":"9007199254740993"}}',
      "history_changed",
    ],
    [
      "positive binary64 collision",
      '{"n":9007199254740992}',
      '{"n":9007199254740993}',
      "history_changed",
    ],
    [
      "provider string changed to bare unsafe integer",
      '{"n":"9007199254740992"}',
      '{"n":9007199254740992}',
      "history_changed",
    ],
    ["unchanged incomplete JSON", '{"n":', '{"n":', "continued"],
    ["changed incomplete JSON", '{"n":', '{"n": }', "history_changed"],
    ["non-object array", "[42]", "[42.0]", "history_changed"],
    ["safe fraction", '{"n":4.20}', '{"n":4.2}', "continued"],
  ] as const)(
    "compares admitted provider tool arguments: %s",
    (_name, rawArguments, replayedArguments, expectedStatus) => {
      const state = continuationState();
      const call = toolCall("call_1", {
        id: "fc_1",
        status: "completed" as const,
        name: "record_value",
        arguments: rawArguments,
      });
      state.lastResponseItems = [call];
      const output = toolOutput("call_1");
      const request = replayRequest(state, [
        ...(state.lastRequest.input ?? []),
        { ...call, arguments: replayedArguments },
        output,
      ]);
      const before = structuredClone({ state, request });
      const resolved = resolveResponsesContinuationRequest(state, request);
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
    ['{"n":9007199254740992}', '{"n":"9007199254740992"}', "history_changed"],
    ['{"n":9007199254740992}', '{"n":9007199254740992}', "continued"],
  ] as const)("keeps already-sent arguments strict: %s -> %s", (sent, current, expectedStatus) => {
    const state = continuationState();
    const call = toolCall("sent_call", {
      name: "record_value",
      arguments: sent,
    });
    const output = toolOutput("sent_call");
    state.lastRequest.input = [...(state.lastRequest.input ?? []), call, output];
    const request = nextRequest();
    const [user, ...next] = request.input ?? [];
    if (!user) {
      throw new Error("Expected the fixture's first user message");
    }
    request.input = [user, { ...call, arguments: current }, output, ...next];
    const before = structuredClone({ state, request });
    const resolved = resolveResponsesContinuationRequest(state, request);
    expect(resolved.continuationStatus).toBe(expectedStatus);
    if (expectedStatus === "history_changed") {
      expect(resolved.request).toBe(request);
    }
    expect({ state, request }).toEqual(before);
  });

  it.each([
    [
      "paired reshape",
      "chatcmpl-tool-20cf1f2fabdd434da069764b4dca72eb",
      "fc_1",
      "call_chatcmpl-tool-20cf1f2fabdd434da069764b4dca72eb_f_3b92d47627",
      true,
    ],
    ["unchanged pair", "functions.gateway:0", "fc_tmp_kegospxl46", "functions.gateway:0", true],
    ["omitted item ID", "functions.gateway:0", "fc_tmp_kegospxl46", "functions.gateway:0", false],
    [
      "bare reshape",
      "functions.gateway:0",
      "fc_tmp_kegospxl46",
      normalizeOpenAIResponsesFunctionCallId("functions.gateway:0"),
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
      const state = continuationState();
      state.lastResponseItems = [{ type: "reasoning" }, call] as never;
      const { id: _id, ...bareCall } = call;
      const request: ResponsesContinuationRequest = {
        ...state.lastRequest,
        input: [
          firstUser,
          { type: "reasoning" },
          {
            ...bareCall,
            ...(keepItemId ? { id: itemId } : {}),
            call_id: replayId,
          },
          toolOutput(replayId, "hi\n"),
        ] as never,
      };
      // The provider pairs against its cached raw ID, never the client-local replay shape.
      expect(resolveResponsesContinuationRequest(state, request)).toMatchObject({
        continuationStatus: "continued",
        request: { previous_response_id: "resp_1", input: [toolOutput(rawId, "hi\n")] },
      });
    },
  );

  it.each([
    ["id", "fc_output_changed", "history_changed"],
    ["call_id", normalizeOpenAIResponsesFunctionCallId("functions.gateway:0"), "continued"],
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
    expect(resolveResponsesContinuationRequest(state, request).continuationStatus).toBe(expected);
  });

  it.each([
    ["unrelated call", "call_original_abc", "call_unrelated_xyz", "call_unrelated_xyz"],
    ["colliding call", " x", "x", "x"],
    ["colliding result", " x", " x", "x"],
  ])("rejects a %s instead of restoring an unowned ID", (_name, rawId, replayId, outputId) => {
    const call = toolCall(rawId, { id: "fc_1", status: "completed" });
    const state = continuationState();
    state.lastResponseItems = [call];
    const request = replayRequest(state, [
      firstUser,
      { ...call, call_id: replayId },
      toolOutput(outputId),
    ]);
    expectHistoryChanged(state, request);
  });

  it("rejects a changed earlier tool result when IDs share a replay shape", () => {
    const canonicalCallId = normalizeOpenAIResponsesFunctionCallId(" x");
    const firstCall = toolCall(canonicalCallId, { name: "first" });
    const secondCall = toolCall(" x", { name: "second" });
    const originalOutput = toolOutput(canonicalCallId);
    const state: ResponsesContinuationState = {
      lastRequest: {
        model: "gpt-5.6-luna",
        store: true,
        input: [firstUser, firstCall, secondCall, originalOutput] as never,
      },
      lastResponseId: "resp_1",
      lastResponseItems: [assistantOutput],
    };
    const request: ResponsesContinuationRequest = {
      ...state.lastRequest,
      input: [
        firstUser,
        firstCall,
        secondCall,
        { ...originalOutput, call_id: " x" },
        assistantOutput,
        secondUser,
      ] as never,
    };

    expectHistoryChanged(state, request);
  });

  it.each([
    ["unrelated call and result", "call_a", "call_b", "call_b"],
    ["colliding call and result", " x", "x", "x"],
    ["colliding result", " x", " x", "x"],
  ])("rejects an earlier %s change", (_name, rawId, replayId, outputId) => {
    const call = toolCall(rawId, { name: "lookup" });
    const state = continuationState();
    state.lastRequest.input = [firstUser, call, toolOutput(rawId)] as never;
    const request: ResponsesContinuationRequest = {
      ...state.lastRequest,
      input: [
        firstUser,
        { ...call, call_id: replayId },
        toolOutput(outputId),
        assistantOutput,
        secondUser,
      ] as never,
    };
    expectHistoryChanged(state, request);
  });

  it("retains pending calls when a result matches a colliding replay shape", () => {
    const canonicalCallId = normalizeOpenAIResponsesFunctionCallId(" x");
    const calls = [toolCall(" x", { name: "async" }), toolCall(canonicalCallId, { name: "sync" })];
    const first = recordResponsesContinuationState(
      undefined,
      { input: [firstUser, ...calls] as never },
      { id: "resp_1", output: calls as never },
    );
    const second = recordResponsesContinuationState(
      first,
      {
        input: [firstUser, ...calls, toolOutput(canonicalCallId, "sync result")] as never,
      },
      { id: "resp_2", output: [assistantOutput] },
      true,
    );

    expect(second.pendingToolCalls).toEqual([{ callId: " x" }, { callId: canonicalCallId }]);
  });

  it("does not let an older result resolve a newer call that reuses its ID", () => {
    const reusedCall = toolCall("call_reused", { name: "lookup" });
    const previous: ResponsesContinuationState = {
      lastRequest: {
        input: [firstUser, reusedCall, toolOutput("call_reused", "old result")] as never,
      },
      lastResponseId: "resp_1",
      lastResponseItems: [reusedCall] as never,
    };
    const current = recordResponsesContinuationState(
      previous,
      {
        input: [
          firstUser,
          reusedCall,
          toolOutput("call_reused", "old result"),
          reusedCall,
        ] as never,
      },
      { id: "resp_2", output: [assistantOutput] },
      true,
    );

    expect(current.pendingToolCalls).toEqual([{ callId: "call_reused" }]);
  });

  it("rebuilds pending call IDs from a full-history fallback", () => {
    const rawCall = toolCall(" x", { name: "async" });
    const replayedCallId = normalizeOpenAIResponsesFunctionCallId(rawCall.call_id);
    const previous = recordResponsesContinuationState(
      undefined,
      { input: [firstUser] as never },
      { id: "resp_1", output: [rawCall] as never },
    );
    const fallback = recordResponsesContinuationState(
      previous,
      { input: [firstUser, { ...rawCall, call_id: replayedCallId }] as never },
      { id: "resp_2", output: [assistantOutput] },
      false,
    );

    expect(fallback.pendingToolCalls).toEqual([{ callId: replayedCallId }]);
  });

  it("keeps raw async call IDs when HTTP commits the full baseline of a continuation", () => {
    const rawCall = toolCall(" x", { name: "async" });
    const replayedCall = {
      ...rawCall,
      call_id: normalizeOpenAIResponsesFunctionCallId(rawCall.call_id),
    };
    const firstRequest: ResponsesContinuationRequest = {
      model: "gpt-5.6-luna",
      store: true,
      input: [firstUser] as never,
    };
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
    const bareReplayCallId = normalizeOpenAIResponsesFunctionCallId(" x");
    const state: ResponsesContinuationState = {
      lastRequest: { model: "gpt-5.6-luna", store: true, input: [firstUser] as never },
      lastResponseId: "resp_1",
      lastResponseItems: cachedCalls as never,
    };
    const request: ResponsesContinuationRequest = {
      model: "gpt-5.6-luna",
      store: true,
      input: [
        firstUser,
        toolCall(bareReplayCallId, { name: "first" }),
        toolCall(bareReplayCallId, { name: "second" }),
        toolOutput(bareReplayCallId),
      ] as never,
    };

    expectHistoryChanged(state, request);
  });

  it("ignores turn correlation headers but isolates explicit authorization", () => {
    const first = claim({ turn: "1" });
    commitBaseline(first, "resp_1");

    const sameTenant = claim({ turn: "2", request: nextRequest() });
    expect(sameTenant?.request.previous_response_id).toBe("resp_1");
    sameTenant?.commit(nextRequest(), { id: "resp_2", output: [] }, "resp_1");

    const rotated = claim({
      turn: "3",
      authorization: "Bearer tenant-b",
      request: nextRequest(),
    });
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

    const next = claim({ request: nextRequest() });
    expect(next?.request.previous_response_id).toBeUndefined();
    next?.release();
  });

  it("keeps matching-session and all-session cleanup inside one runtime owner", () => {
    const firstHost = createAiTransportHost();
    const secondHost = createAiTransportHost();
    const commit = (owner: typeof firstHost, sessionId: string, responseId: string) =>
      runWithAiTransportHost(owner, () => {
        commitBaseline(claim({ sessionId }), responseId);
      });
    const previousResponseId = (owner: typeof firstHost, sessionId: string) =>
      runWithAiTransportHost(owner, () => {
        const claimed = claim({ sessionId, request: nextRequest() });
        const responseId = claimed?.request.previous_response_id;
        claimed?.release();
        return responseId;
      });

    commit(firstHost, "shared", "first-shared");
    commit(firstHost, "other", "first-other");
    commit(secondHost, "shared", "second-shared");
    commit(secondHost, "other", "second-other");

    cleanupSessionResources("shared", firstHost);
    expect(previousResponseId(firstHost, "shared")).toBeUndefined();
    expect(previousResponseId(secondHost, "shared")).toBe("second-shared");

    cleanupSessionResources(undefined, firstHost);
    expect(previousResponseId(firstHost, "other")).toBeUndefined();
    expect(previousResponseId(secondHost, "other")).toBe("second-other");
  });

  it("keeps preparation exclusive and preserves a cleanup-time replacement after failure", () => {
    commitBaseline(claim({}), "resp_first");
    let replacement: ReturnType<typeof claim>;
    const request = {
      ...nextRequest(),
      metadata: {
        value: {
          toJSON() {
            expect(claim({})).toBeUndefined();
            cleanupSessionResources("session-1");
            replacement = claim({});
            throw new Error("serialization failed after replacement");
          },
        },
      },
    };
    expect(() => claim({ request })).toThrow("serialization failed after replacement");
    expect(replacement).toBeDefined();
    expect(claim({})).toBeUndefined();
    commitBaseline(replacement, "resp_replacement");
    const next = claim({ request: nextRequest() });
    expect(next?.request.previous_response_id).toBe("resp_replacement");
    next?.release();
  });
});

describe("OpenAI Responses continuation cache bounds", () => {
  // Exercise the production count and serialized-byte limits without exporting test-only seams.
  const capacity = 1000;
  const byteBudget = 64 * 1024 * 1024;
  const responseItems = (text: string) => [
    {
      ...assistantOutput,
      content: [{ type: "output_text" as const, text, annotations: [], logprobs: [] }],
    },
  ];
  function commit(sessionId: string, responseId: string, text = "answer") {
    claim({ sessionId })?.commit(continuationState().lastRequest, {
      id: responseId,
      output: responseItems(text),
    });
  }
  function previousResponseId(sessionId: string, text = "answer") {
    const next = claim({ sessionId, request: nextRequest("final_answer", text) });
    const id = next?.request.previous_response_id;
    next?.release();
    return id;
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
