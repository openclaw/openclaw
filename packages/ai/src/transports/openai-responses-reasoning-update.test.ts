import { afterEach, assert, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState as Continuation,
} from "./openai-responses-continuation.js";
import { inputMessage as user } from "./openai-responses-prompt-observer.test-support.js";
import { wireMessage } from "./openai-stream-cases.test-support.js";

type Input = NonNullable<ResponsesContinuationRequest["input"]>;
const answer = wireMessage("msg_answer", "answer");
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const initial = (extra: Record<string, unknown> = {}, mode?: "pro"): Continuation => ({
  lastRequest: {
    model: "gpt-6-astra",
    reasoning: { effort: "low", summary: "auto", mode },
    input: [user("first")],
    ...extra,
  },
  lastResponseId: "resp_1",
  lastResponseItems: [answer],
});
const next = (effort = "high", extra: Record<string, unknown> = {}, mode?: "pro") =>
  ({
    ...initial().lastRequest,
    reasoning: { effort, summary: "auto", mode },
    input: [user("first"), answer, user("second")],
    ...extra,
  }) satisfies ResponsesContinuationRequest;
function expectUnchanged(request: ResponsesContinuationRequest, previous = initial()) {
  const result = resolveResponsesContinuationRequest(previous, request);
  expect(result.request).toBe(request);
  expect(result.fullRequest).toBeUndefined();
  return result.request;
}

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

it.each(["high", "max", "xhigh"])(
  "keeps the request effort and original update positions through %s turns",
  (effort) => {
    const state = initial();
    let input: Input = [user("first")];
    const expected: unknown[] = [...input];
    for (const [index, chosen] of [effort, "medium"].entries()) {
      const turn = index === 0 ? "second" : "third";
      const request = { ...next(chosen), input: [...input, answer, user(turn)] };
      const before = structuredClone({ state, request });
      const result = resolveResponsesContinuationRequest(state, request);
      expect(result.request).toMatchObject({
        previous_response_id: `resp_${index + 1}`,
        reasoning: { effort: "low" },
        input: [update(chosen), user(turn)],
      });
      assert(result.fullRequest);
      expected.push(answer, update(chosen), user(turn));
      expect(result.fullRequest.input).toEqual(expected);
      expect({ state, request }).toEqual(before);
      state.lastRequest = result.fullRequest;
      state.lastResponseId = `resp_${index + 2}`;
      input = request.input;
    }
    const unchanged = resolveResponsesContinuationRequest(state, {
      ...next("medium"),
      input: [...input, answer, user("fourth")],
    });
    expect(unchanged.request.input).toEqual([user("fourth")]);
    expect(unchanged.request.reasoning).toMatchObject({ effort: "low" });
  },
);

it.each<[string, Record<string, unknown>, "pro"?]>([
  ["another model", { model: "gpt-5.6-luna" }],
  ["pro mode", {}, "pro"],
  ["multi-agent", { multi_agent: { enabled: true } }],
  ["automatic truncation", { truncation: "auto" }],
  [
    "automatic compaction",
    { context_management: [{ type: "compaction", compact_threshold: 1000 }] },
  ],
])("leaves %s on request-level effort", (_name, extra, mode) => {
  expectUnchanged(next("high", extra, mode), initial(extra, mode));
});

it("drops provisional updates when the original history changed or no new user exists", () => {
  for (const input of [
    [user("edited"), answer, user("second")],
    [user("first"), answer],
  ]) {
    const request = { ...next(), input };
    expect(expectUnchanged(request).reasoning).toMatchObject({ effort: "high" });
  }
});

it.each<[Input, string]>([
  [[], "history_shorter"],
  [[user("edited"), answer, user("second")], "history_changed"],
  [[user("first"), { ...answer, content: [] }, user("second")], "history_changed"],
])("keeps required-input history validation: %j => %s", (input, expectedStatus) => {
  const request = { ...next(), max_output_tokens: 512, input };
  const result = resolveResponsesContinuationRequest(initial(), request, "required-input");
  expect(result).toEqual({ request, continuationStatus: expectedStatus });
  expect(result.request.previous_response_id).toBeUndefined();
});

it("replays unstored HTTP input and resets to the chosen effort after cache expiry", () => {
  vi.useFakeTimers();
  const claim = (request: ResponsesContinuationRequest) =>
    claimOpenAIResponsesHttpContinuation({
      sessionId: "reasoning-session",
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      headers: {},
      request: { ...request, store: false },
    });
  const first = claim(initial().lastRequest);
  assert(first);
  first.commit(first.fullRequest, { id: "resp_1", output: [answer] });
  const second = claim(next());
  assert(second);
  expect(second.request.previous_response_id).toBeUndefined();
  expect(second.request.reasoning).toMatchObject({ effort: "low" });
  expect(second.request.input).toEqual([user("first"), answer, update("high"), user("second")]);
  second.commit(second.fullRequest, { id: "resp_2", output: [answer] });
  vi.advanceTimersByTime(90 * 60 * 1000 + 1); // Exceed private HTTP_CONTINUATION_IDLE_TTL_MS.
  const third = claim({ ...next("medium"), input: [...next().input, answer, user("third")] });
  assert(third);
  expect(third.request.previous_response_id).toBeUndefined();
  expect(third.request.reasoning).toMatchObject({ effort: "medium" });
  expect(third.request.input).not.toContainEqual(update("high"));
  third.release();
});
