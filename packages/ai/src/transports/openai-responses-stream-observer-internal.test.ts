import { createHook } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { observeResponsesStream } from "./openai-responses-stream-observer-internal.js";
import { log } from "./openai-transport-shared.js";

const model = makeProviderModel("openai-responses", "openai", "test-model");
const event = { type: "response.output_text.delta", delta: "hello" };

afterEach(() => vi.restoreAllMocks());

describe("Responses stream observation", () => {
  it.runIf(!process.versions.bun)("adds only one promise per delivered event", async () => {
    const result = { done: false as const, value: event };
    const observed = observeResponsesStream(
      {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(result) }),
      },
      model,
    );
    // Initialize diagnostics outside the per-update accounting window.
    await observed.next();
    let promises = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === "PROMISE") {
          promises++;
        }
      },
    });
    for (let index = 0; index < 10; index++) {
      let pending: ReturnType<typeof observed.next>;
      hook.enable();
      try {
        pending = observed.next();
      } finally {
        hook.disable();
      }
      await pending;
    }
    // One source promise plus one observation continuation for each read.
    expect(promises).toBe(20);
    await observed.return?.();
  });

  it("starts lazily and reports every event and completion exactly once", async () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const events = [
      { type: "response.created", response: { id: "synthetic-response" } },
      event,
      {
        type: "response.completed",
        response: { service_tier: "default", usage: { output_tokens: 4 } },
      },
    ];
    const source = (async function* () {
      yield* events;
      return "discarded source return value";
    })();
    const observed = observeResponsesStream(source, model);
    expect(debug).not.toHaveBeenCalled();
    const received = [];
    for await (const value of observed) {
      received.push(value);
    }
    expect(received).toEqual(events);
    expect(debug).toHaveBeenCalledTimes(3);
    expect(debug.mock.calls[2]?.[0]).toContain("terminal=response.completed");
    expect(debug.mock.calls[2]?.[0]).toContain("events=3");
    await observed.next();
    await observed.return?.();
    expect(debug).toHaveBeenCalledTimes(3);
  });
});
