import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { observeResponsesStream } from "./openai-responses-stream-observer-internal.js";
import { log } from "./openai-transport-shared.js";

const model = makeProviderModel("openai-responses", "openai", "test-model");
const event = { type: "response.output_text.delta", delta: "hello" };

function fixture(next: AsyncIterator<unknown>["next"]) {
  const iterator = {
    next: vi.fn(next),
    return: vi.fn(async () => ({ done: true as const, value: undefined })),
    throw: vi.fn(async (error: unknown) => {
      throw error;
    }),
  };
  const open = vi.fn(() => iterator);
  return {
    iterator,
    open,
    observed: observeResponsesStream({ [Symbol.asyncIterator]: open }, model),
  };
}

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

  it.each(["return", "throw"] as const)(
    "does not open a source on %s before first read",
    async (method) => {
      const { observed, open } = fixture(() => Promise.resolve({ done: false, value: event }));
      const error = new Error("consumer");
      if (method === "throw") {
        await expect(observed.throw?.(error)).rejects.toBe(error);
      } else {
        await expect(observed.return?.("consumer value")).resolves.toEqual({
          done: true,
          value: "consumer value",
        });
      }
      expect(open).not.toHaveBeenCalled();
      await expect(observed.next()).resolves.toEqual({ done: true, value: undefined });
    },
  );

  it("serializes overlapping reads and return without reading ahead of observation", async () => {
    const first = createDeferred<IteratorResult<unknown>>();
    const { observed, iterator } = fixture(() => first.promise);
    const one = observed.next();
    const two = observed.next();
    const closing = observed.return?.("consumer value");
    expect(iterator.next).toHaveBeenCalledTimes(1);
    iterator.next.mockResolvedValue({ done: false, value: event });
    first.resolve({ done: false, value: event });
    expect(await one).toEqual({ done: false, value: event });
    expect(await two).toEqual({ done: false, value: event });
    expect(await closing).toEqual({ done: true, value: "consumer value" });
    expect(iterator.next).toHaveBeenCalledTimes(2);
    expect(iterator.return).toHaveBeenCalledExactlyOnceWith();
    await observed.next();
    expect(iterator.next).toHaveBeenCalledTimes(2);
  });

  it("preserves source rejection identity without returning an already failed source", async () => {
    const error = new Error("provider");
    const { observed, iterator } = fixture(() => Promise.reject(error));
    await expect(observed.next()).rejects.toBe(error);
    expect(iterator.return).not.toHaveBeenCalled();
    await expect(observed.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each(["consumer", "observer"] as const)(
    "closes on %s errors and preserves the original error over cleanup failure",
    async (kind) => {
      const error = new Error(kind);
      const value =
        kind === "consumer"
          ? event
          : {
              get type(): string {
                throw error;
              },
            };
      const { observed, iterator } = fixture(() => Promise.resolve({ done: false, value }));
      iterator.return.mockRejectedValue(new Error("cleanup"));
      if (kind === "consumer") {
        await observed.next();
        await expect(observed.throw?.(error)).rejects.toBe(error);
      } else {
        await expect(observed.next()).rejects.toBe(error);
      }
      expect(iterator.return).toHaveBeenCalledExactlyOnceWith();
      expect(iterator.throw).not.toHaveBeenCalled();
      await expect(observed.next()).resolves.toEqual({ done: true, value: undefined });
    },
  );

  it("closes when a consumer return value rejects", async () => {
    const error = new Error("return value");
    const { observed, iterator } = fixture(() => Promise.resolve({ done: false, value: event }));
    await observed.next();
    await expect(observed.return?.(Promise.reject(error))).rejects.toBe(error);
    expect(iterator.return).toHaveBeenCalledExactlyOnceWith();
    await expect(observed.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each(["source", "observer"] as const)(
    "settles an overlapping %s failure before queued completion",
    async (kind) => {
      const error = new Error(kind);
      const first = createDeferred<IteratorResult<unknown>>();
      const { observed, iterator } = fixture(() => first.promise);
      const settled: string[] = [];
      const one = observed.next().catch((rejection: unknown) => {
        expect(rejection).toBe(error);
        settled.push("failed");
      });
      const two = observed.next().then((result) => {
        expect(result).toEqual({ done: true, value: undefined });
        settled.push("finished");
      });
      if (kind === "source") {
        first.reject(error);
      } else {
        first.resolve({
          done: false,
          value: {
            get type() {
              throw error;
            },
          },
        });
      }
      await Promise.all([one, two]);
      expect(settled).toEqual(["failed", "finished"]);
      expect(iterator.return).toHaveBeenCalledTimes(kind === "observer" ? 1 : 0);
    },
  );

  it("keeps queued reads and cleanup in the active read's context", async () => {
    const context = new AsyncLocalStorage<string>();
    const first = createDeferred<IteratorResult<unknown>>();
    const seen: string[] = [];
    const value = {
      get type() {
        seen.push(`observe:${context.getStore()}`);
        return "response.output_text.delta";
      },
    };
    let reads = 0;
    const observed = observeResponsesStream(
      {
        [Symbol.asyncIterator]: () => ({
          next() {
            seen.push(`read:${context.getStore()}`);
            return reads++ === 0 ? first.promise : Promise.resolve({ done: false, value });
          },
          async return() {
            seen.push(`close:${context.getStore()}`);
            return { done: true as const, value: undefined };
          },
        }),
      },
      model,
    );
    const one = context.run("active", () => observed.next());
    const two = context.run("queued-read", () => observed.next());
    const closing = context.run("queued-close", () => observed.return?.());
    first.resolve({ done: false, value });
    await Promise.all([one, two, closing]);
    expect(reads).toBe(2);
    expect(seen.filter((entry) => entry.startsWith("observe:")).length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe("close:active");
    expect(seen.every((entry) => entry.endsWith(":active"))).toBe(true);
  });

  it("retains read context through asynchronous source settlement", async () => {
    const context = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const { observed } = fixture(() =>
      Promise.resolve({
        done: false,
        value: {
          get type() {
            seen.push(context.getStore());
            return "response.output_text.delta";
          },
        },
      }),
    );
    await context.run("turn-context", () => observed.next());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === "turn-context")).toBe(true);
    await observed.return?.();
  });
});
