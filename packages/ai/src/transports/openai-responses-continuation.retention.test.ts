import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
} from "../../../../src/shared/immutable-data.js";
import { createAiTransportHost, runWithAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  recordResponsesContinuationState,
} from "./openai-responses-continuation.js";

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

it("reuses retained history byte counts past mutable items without walking their contents again", () => {
  const host = createAiTransportHost({
    immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
  });
  runWithAiTransportHost(host, () => {
    const request = {
      model: "fixture",
      input: [
        { role: "user" as const, content: "x".repeat(1024 * 1024) },
        ...Array.from({ length: 600 }, (_, index) =>
          freezeJsonSnapshot({
            type: "message" as const,
            role: "user" as const,
            content: [{ type: "input_text" as const, text: `history ${index}` }],
          }),
        ),
      ],
    };
    const claim = claimOpenAIResponsesHttpContinuation({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      headers: {},
      sessionId: "byte-work",
      request,
    });
    assert.ok(claim);
    claim.commit(request, { id: "response", output: [] });
    const next = claimOpenAIResponsesHttpContinuation({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      headers: {},
      sessionId: "byte-work",
      request: { ...request, previous_response_id: "response" },
    });
    assert.ok(next);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      next.commit(request, { id: "next-response", output: [] }, "response");
      const serializedCharacters = stringify.mock.results.reduce(
        (total, result) =>
          total +
          (result.type === "return" && typeof result.value === "string" ? result.value.length : 0),
        0,
      );
      expect(serializedCharacters).toBeLessThan(4096);
    } finally {
      stringify.mockRestore();
      cleanupSessionResources("byte-work", host);
    }
  });
});

it.each([0, 1])("preserves the exact serialized byte budget (overflow=%s)", (overflow) => {
  const identity = {
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    headers: {},
    sessionId: "exact-bytes",
  };
  const host = createAiTransportHost({
    immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
  });
  runWithAiTransportHost(host, () => {
    const input = { role: "user" as const, content: "" };
    const history = Array.from({ length: 150 }, (_, index) => [
      {
        role: "user" as const,
        content: [
          {
            type: "input_image" as const,
            detail: "auto" as const,
            image_url: `https://example.test/${index}.png`,
          },
        ],
      },
      freezeJsonSnapshot({
        type: "reasoning" as const,
        id: `rs_${index}`,
        summary: [],
        encrypted_content: `sealed-${index}`,
      }),
      freezeJsonSnapshot({
        type: "function_call" as const,
        call_id: `call_${index}`,
        name: "lookup",
        arguments: '{"q":"🦞"}',
      }),
      freezeJsonSnapshot({
        type: "function_call_output" as const,
        call_id: `call_${index}`,
        output: `result ${index}`,
      }),
    ]).flat();
    const request = {
      model: "fixture",
      input: [input, ...history],
      options: {
        omitted: undefined,
        array: [undefined, Number.NaN, Infinity],
        toJSONValue: { toJSON: (key: string) => ({ key }) },
      },
    };
    const response = { id: "response", output: [] };
    const overhead = Buffer.byteLength(
      JSON.stringify(recordResponsesContinuationState(undefined, request, response)),
    );
    const escapes = '\0\b\t\n\v\f\r\u001f"\\é漢🦞\ud800x\udfff';
    const escapedBytes = Buffer.byteLength(JSON.stringify(escapes)) - 2;
    input.content = "x".repeat(64 * 1024 * 1024 - overhead - escapedBytes) + escapes;
    const claim = claimOpenAIResponsesHttpContinuation({ ...identity, request });
    assert.ok(claim);
    try {
      claim.commit(request, response);
      // Reorder, truncate and append admitted entries, and mutate an image publication.
      request.input = [
        input,
        ...history.slice(8),
        ...history.slice(0, 4),
        freezeJsonSnapshot({ role: "user" as const, content: "appended 🦞" }),
      ];
      const image = history.find((item) => "content" in item);
      assert.ok(image);
      const imagePart = image.content[0];
      assert.ok(imagePart);
      imagePart.image_url += "/changed";
      input.content = "";
      const resized = Buffer.byteLength(
        JSON.stringify(recordResponsesContinuationState(undefined, request, response)),
      );
      input.content = "x".repeat(64 * 1024 * 1024 - resized - escapedBytes) + escapes;
      if (overflow) {
        input.content += "x";
      }
      const changed = claimOpenAIResponsesHttpContinuation({
        ...identity,
        request: { ...request, previous_response_id: response.id },
      });
      assert.ok(changed);
      changed.commit(request, response, response.id);
      const restoreRequest = vi.fn(() => ({ model: "fixture", input: [] }));
      const next = claimOpenAIResponsesHttpContinuation({
        ...identity,
        request: { model: "fixture", input: [] },
        restoreRequest,
      });
      expect(restoreRequest).toHaveBeenCalledTimes(overflow);
      next?.release();
    } finally {
      cleanupSessionResources(identity.sessionId, host);
    }
  });
});
