import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./openai-responses-continuation.js";

// Must track MAX_HTTP_CONTINUATION_READY_ENTRIES in
// openai-responses-continuation.ts (a private module constant, not exported
// -- nothing outside this module or its own test needs it) -- keep this
// number in sync with the real cap for the eviction tests below to actually
// exercise the capacity boundary.
const READY_ENTRY_CAPACITY = 1000;
// Must track MAX_HTTP_CONTINUATION_RETAINED_BYTES in
// openai-responses-continuation.ts (a private module constant, not exported)
// -- keep this number in sync with the real budget for the tests below to
// actually exercise the byte-budget boundary.
const RETAINED_BYTES_BUDGET = 64 * 1024 * 1024;

const firstUser = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "first" }],
};
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

/** Builds response.output content whose serialized size is at least `bytes`
 * -- used to exercise the byte-budget boundary without depending on the
 * production estimator's exact formula. */
function oversizedResponseItems(bytes: number): unknown[] {
  return [
    {
      ...assistantOutput,
      content: [{ type: "output_text", text: "x".repeat(bytes), annotations: [], logprobs: [] }],
    },
  ];
}

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

function nextRequest(phase = "final_answer"): ResponsesContinuationRequest {
  return {
    input: [
      firstUser,
      {
        type: "message",
        role: "assistant",
        phase,
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
    ] as never,
    metadata: { openclaw_turn_attempt: "2", openclaw_turn_id: "turn-2", stable: "yes" },
    store: true,
    model: "gpt-5.6-luna",
  };
}

/** Like nextRequest(), but echoes back the same oversized assistant reply
 * text oversizedResponseItems(bytes) committed -- resolveResponsesContinuationRequest
 * requires the replayed assistant turn to match the retained baseline
 * verbatim, so a plain nextRequest() (hardcoded small "answer" text) would
 * correctly report history_changed against an oversized baseline, not
 * "continued" -- that's the resolver working, not the eviction bug this
 * test targets. */
function nextRequestAfterOversized(bytes: number): ResponsesContinuationRequest {
  return {
    input: [
      firstUser,
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "x".repeat(bytes), annotations: [] }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
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

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

describe("OpenAI Responses continuation cache bounds", () => {
  it("expires completed continuation state after the default 90-minute idle TTL", () => {
    vi.useFakeTimers();
    const first = claim({});
    first?.commit(continuationState().lastRequest, {
      id: "resp_expiring",
      output: continuationState().lastResponseItems,
    });
    // Must track HTTP_CONTINUATION_IDLE_TTL_MS in openai-responses-continuation.ts
    // (a private module constant, not exported) -- this advance needs to
    // exceed the real idle TTL for the expiry to actually fire.
    vi.advanceTimersByTime(90 * 60 * 1000 + 1);

    const next = claim({ request: nextRequest() });
    expect(next?.request.previous_response_id).toBeUndefined();
    next?.release();
  });

  it("survives a gap shorter than the default 90-minute idle TTL", () => {
    vi.useFakeTimers();
    const first = claim({});
    first?.commit(continuationState().lastRequest, {
      id: "resp_surviving",
      output: continuationState().lastResponseItems,
    });
    vi.advanceTimersByTime(89 * 60 * 1000);

    const next = claim({ request: nextRequest() });
    expect(next?.request.previous_response_id).toBe("resp_surviving");
    next?.release();
  });

  it("evicts the oldest ready entry once the process-wide capacity is reached", () => {
    // Fill the cache to capacity with distinct sessions, oldest first, so
    // the default 90-minute idle TTL alone can't be relied on to bound
    // memory during a burst of concurrent sessions.
    for (let i = 0; i < READY_ENTRY_CAPACITY; i++) {
      const c = claim({ sessionId: `session-${i}` });
      c?.commit(continuationState().lastRequest, {
        id: `resp-${i}`,
        output: continuationState().lastResponseItems,
      });
    }

    // One more commit pushes the map over capacity; the oldest-committed
    // entry (session-0) should be evicted to make room.
    const overflow = claim({ sessionId: "session-overflow" });
    overflow?.commit(continuationState().lastRequest, {
      id: "resp-overflow",
      output: continuationState().lastResponseItems,
    });

    const evicted = claim({ sessionId: "session-0", request: nextRequest() });
    expect(evicted?.request.previous_response_id).toBeUndefined();
    evicted?.release();

    const survivorId = `session-${READY_ENTRY_CAPACITY - 1}`;
    const survivor = claim({ sessionId: survivorId, request: nextRequest() });
    expect(survivor?.request.previous_response_id).toBe(`resp-${READY_ENTRY_CAPACITY - 1}`);
    survivor?.release();
  });

  it("evicts the oldest committed baseline after a same-millisecond reclaim", () => {
    // Freeze time so ordering must follow commits, including reclaimed keys.
    vi.useFakeTimers();
    try {
      for (let i = 0; i < READY_ENTRY_CAPACITY; i++) {
        const c = claim({ sessionId: `reclaim-session-${i}` });
        c?.commit(continuationState().lastRequest, {
          id: `reclaim-resp-${i}`,
          output: continuationState().lastResponseItems,
        });
      }

      // Reclaiming the oldest session must make its next baseline newest.
      const reclaimed = claim({ sessionId: "reclaim-session-0", request: nextRequest() });
      expect(reclaimed?.request.previous_response_id).toBe("reclaim-resp-0");
      reclaimed?.commit(continuationState().lastRequest, {
        id: "reclaim-resp-0-refreshed",
        output: continuationState().lastResponseItems,
      });

      // One more commit pushes the map over capacity again.
      const overflow = claim({ sessionId: "reclaim-session-overflow" });
      overflow?.commit(continuationState().lastRequest, {
        id: "reclaim-resp-overflow",
        output: continuationState().lastResponseItems,
      });

      // The just-reclaimed entry must survive -- it is the newest by true
      // commit order, regardless of its Map position or tied timestamp.
      const stillReady = claim({ sessionId: "reclaim-session-0", request: nextRequest() });
      expect(stillReady?.request.previous_response_id).toBe("reclaim-resp-0-refreshed");
      stillReady?.release();

      // The entry actually oldest by commit order (never reclaimed) is the
      // one that gets evicted instead.
      const evicted = claim({ sessionId: "reclaim-session-1", request: nextRequest() });
      expect(evicted?.request.previous_response_id).toBeUndefined();
      evicted?.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips an oversized entry without evicting another ready session", () => {
    claim({ sessionId: "retained-neighbor" })?.commit(continuationState().lastRequest, {
      id: "resp_neighbor",
      output: continuationState().lastResponseItems,
    });
    const first = claim({});
    // Evicting every other entry still wouldn't make this one fit, so the
    // commit must be a no-op for caching purposes rather than trying to make
    // room for it.
    first?.commit(continuationState().lastRequest, {
      id: "resp_oversized",
      output: oversizedResponseItems(RETAINED_BYTES_BUDGET + 1) as never,
    });

    // Not cached: the next claim for the same session sees no baseline.
    const afterOversized = claim({
      request: nextRequestAfterOversized(RETAINED_BYTES_BUDGET + 1),
    });
    expect(afterOversized?.request.previous_response_id).toBeUndefined();
    const neighbor = claim({ sessionId: "retained-neighbor", request: nextRequest() });
    expect(neighbor?.request.previous_response_id).toBe("resp_neighbor");
    neighbor?.release();

    // The oversized commit must not leave the entry stuck "claimed" forever
    // -- a normal-sized commit right after succeeds and is retained.
    afterOversized?.commit(continuationState().lastRequest, {
      id: "resp_normal",
      output: continuationState().lastResponseItems,
    });
    const afterNormal = claim({ request: nextRequest() });
    expect(afterNormal?.request.previous_response_id).toBe("resp_normal");
    afterNormal?.release();
  });

  it("evicts the oldest ready entries once the aggregate retained-byte budget is reached, well below the count cap", () => {
    // Each entry is sized well under a quarter of the budget (leaving slack
    // for the surrounding JSON structure's own bytes, on top of the raw
    // text run sized here) so 4 entries stay comfortably under budget and
    // the 5th genuinely pushes the running total over it -- the budget, not
    // the 1000-entry count cap, is what forces eviction here.
    const entryBytes = Math.floor(RETAINED_BYTES_BUDGET / 5);
    const fillEntries = 4;
    for (let i = 0; i < fillEntries; i++) {
      const c = claim({ sessionId: `budget-session-${i}` });
      c?.commit(continuationState().lastRequest, {
        id: `budget-resp-${i}`,
        output: oversizedResponseItems(entryBytes) as never,
      });
    }

    // One more commit of the same size pushes the running total over budget;
    // the oldest entry (budget-session-0) must be evicted to make room, well
    // short of the 1000-entry count cap.
    const overflow = claim({ sessionId: "budget-session-overflow" });
    overflow?.commit(continuationState().lastRequest, {
      id: "budget-resp-overflow",
      output: oversizedResponseItems(entryBytes) as never,
    });

    const evicted = claim({
      sessionId: "budget-session-0",
      request: nextRequestAfterOversized(entryBytes),
    });
    expect(evicted?.request.previous_response_id).toBeUndefined();
    evicted?.release();

    const survivorId = `budget-session-${fillEntries - 1}`;
    const survivor = claim({
      sessionId: survivorId,
      request: nextRequestAfterOversized(entryBytes),
    });
    expect(survivor?.request.previous_response_id).toBe(`budget-resp-${fillEntries - 1}`);
    survivor?.release();
  });

  it("does not overwrite a replacement claim that starts while the stale commit is still serializing", () => {
    // estimateRetainedBytes runs JSON.stringify over the committed
    // request/response to size it against the byte budget. That stringify
    // synchronously invokes any toJSON a caller-supplied value defines --
    // this simulates a caller whose toJSON callback runs session cleanup and
    // starts a brand-new claim at the exact same key, mid-serialization, the
    // same way a genuinely concurrent turn's cleanup + reclaim could
    // interleave with this commit's own (already in-flight) work.
    const raceParams = { sessionId: "toJSON-race-session" };
    const first = claim(raceParams);
    let replacement: ReturnType<typeof claim>;
    const raceOutput = {
      ...assistantOutput,
      toJSON() {
        cleanupSessionResources(raceParams.sessionId);
        replacement = claim(raceParams);
        return { ...assistantOutput };
      },
    };
    first?.commit(continuationState().lastRequest, {
      id: "resp_race",
      output: [raceOutput] as never,
    });

    // The replacement claim must still own the key afterward: a fixed commit
    // re-checks ownership right after serialization and bails out instead of
    // clobbering the replacement with a stale "ready" entry. If it didn't,
    // a third claim attempt here would wrongly succeed against resurrected
    // state instead of correctly finding the key still busy.
    expect(replacement).toBeDefined();
    expect(claim(raceParams)).toBeUndefined();
    replacement?.release();
  });
});
