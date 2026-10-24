import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import { createAiTransportHost, runWithAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { claimOpenAIResponsesHttpContinuation } from "./openai-responses-continuation.js";

const runDetached = AsyncLocalStorage.snapshot();

it("keeps reusable responses without retaining completed callers or prior baselines", async () => {
  const host = createAiTransportHost({ runInDetachedAsyncContext: runDetached });
  const callers = new AsyncLocalStorage<object>();
  const references: WeakRef<object>[] = [];
  const identity = { apiKey: "test-key", baseUrl: "https://example.test/v1", headers: {} };

  function completeTurn(index: number) {
    const caller = { index };
    const previousRequest = { model: "fixture", input: [] };
    references.push(new WeakRef(caller), new WeakRef(previousRequest));
    runWithAiTransportHost(host, () =>
      callers.run(caller, () => {
        const sessionId = `retention-${index}`;
        const first = claimOpenAIResponsesHttpContinuation({
          ...identity,
          sessionId,
          request: previousRequest,
        });
        assert.ok(first);
        first.commit(previousRequest, { id: `previous-${index}`, output: [] });
        const request = { model: "fixture", input: [] };
        const next = claimOpenAIResponsesHttpContinuation({ ...identity, sessionId, request });
        assert.ok(next);
        expect(next.request.previous_response_id).toBe(`previous-${index}`);
        next.commit(request, { id: `current-${index}`, output: [] }, `previous-${index}`);
        expect(callers.getStore()).toBe(caller);
      }),
    );
  }

  try {
    for (let index = 0; index < 20; index += 1) {
      completeTurn(index);
    }
    const control = new WeakRef({ unowned: true });
    // End the creation job before GC; leave the real 90-minute timers and ALS enabled.
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(references.filter((reference) => reference.deref())).toHaveLength(0);

    runWithAiTransportHost(host, () => {
      for (let index = 0; index < 20; index += 1) {
        const next = claimOpenAIResponsesHttpContinuation({
          ...identity,
          sessionId: `retention-${index}`,
          request: { model: "fixture", input: [] },
        });
        assert.ok(next);
        expect(next.request.previous_response_id).toBe(`current-${index}`);
        next.release();
      }
    });
  } finally {
    cleanupSessionResources(undefined, host);
    callers.disable();
  }
});
