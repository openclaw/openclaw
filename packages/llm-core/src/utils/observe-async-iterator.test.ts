import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { observeAsyncIterator } from "./observe-async-iterator.js";

function fixture(next: AsyncIterator<number>["next"] = async () => ({ done: false, value: 1 })) {
  const source = {
    next: vi.fn(next),
    return: vi.fn(async () => ({ done: true as const, value: 9 })),
  };
  const hooks = { onStart: vi.fn(), onEvent: vi.fn(), onDone: vi.fn(), onFinally: vi.fn() };
  const open = vi.fn(() => source);
  return { source, hooks, open };
}

// Run the same external contract against the language generator and the helper.
// This keeps the expected ordering independent of our queue implementation.
describe.each(["generator", "observer"])("observeAsyncIterator: %s contract", (implementation) => {
  function observe(f: ReturnType<typeof fixture>): Required<AsyncIterableIterator<number>> {
    if (implementation === "observer") {
      return observeAsyncIterator({ iterator: f.open, ...f.hooks });
    }
    return (async function* () {
      f.hooks.onStart();
      try {
        for await (const value of { [Symbol.asyncIterator]: f.open }) {
          f.hooks.onEvent(value);
          yield value;
        }
        f.hooks.onDone();
      } finally {
        f.hooks.onFinally();
      }
    })();
  }

  it.each(["return", "throw"] as const)("does not start on unopened %s", async (method) => {
    const f = fixture();
    const stream = observe(f);
    const error = new Error("consumer");
    if (method === "return") {
      await expect(stream.return(Promise.resolve(2))).resolves.toEqual({ done: true, value: 2 });
    } else {
      await expect(stream.throw(error)).rejects.toBe(error);
    }
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.hooks.onStart).not.toHaveBeenCalled();
    expect(f.hooks.onFinally).not.toHaveBeenCalled();
  });

  it("orders overlapping reads and return, preserving the active async context", async () => {
    const context = new AsyncLocalStorage<string>();
    const gate = Promise.withResolvers<IteratorResult<number>>();
    const seen: string[] = [];
    const f = fixture(() => {
      seen.push(`read:${context.getStore()}`);
      return f.source.next.mock.calls.length === 1
        ? gate.promise
        : Promise.resolve({ done: false, value: 2 });
    });
    f.hooks.onEvent.mockImplementation(() => {
      seen.push(`event:${context.getStore()}`);
    });
    f.source.return.mockImplementation(async () => {
      seen.push(`close:${context.getStore()}`);
      return { done: true, value: 9 };
    });
    const stream = observe(f);
    const settled: string[] = [];
    const one = context
      .run("active", () => stream.next())
      .then((result) => {
        settled.push("one");
        return result;
      });
    const two = context
      .run("queued", () => stream.next())
      .then((result) => {
        settled.push("two");
        return result;
      });
    const closing = context
      .run("return", () => stream.return(7))
      .then((result) => {
        settled.push("close");
        return result;
      });
    expect(f.source.next).toHaveBeenCalledOnce();
    expect(f.source.return).not.toHaveBeenCalled();
    gate.resolve({ done: false, value: 1 });
    expect(await Promise.all([one, two, closing])).toEqual([
      { done: false, value: 1 },
      { done: false, value: 2 },
      { done: true, value: 7 },
    ]);
    expect(settled).toEqual(["one", "two", "close"]);
    expect(seen).toEqual([
      "read:active",
      "event:active",
      "read:active",
      "event:active",
      "close:active",
    ]);
    expect(f.source.return).toHaveBeenCalledExactlyOnceWith();
    expect(f.hooks.onFinally).toHaveBeenCalledOnce();
    await stream.return();
    expect(f.hooks.onFinally).toHaveBeenCalledOnce();
  });

  it.each(["source", "result", "value", "observer", "throw", "return-value"] as const)(
    "preserves %s errors and closes exactly when generator cleanup requires it",
    async (kind) => {
      const error = new Error(kind);
      const f = fixture();
      f.source.return.mockRejectedValue(new Error("cleanup"));
      const stream = observe(f);
      await stream.next();
      if (kind === "source") {
        f.source.next.mockRejectedValue(error);
      } else if (kind === "result") {
        f.source.next.mockResolvedValue({
          get done(): false {
            throw error;
          },
          value: 1,
        });
      } else if (kind === "value") {
        f.source.next.mockResolvedValue({
          done: false,
          get value(): number {
            throw error;
          },
        });
      } else if (kind === "observer") {
        f.hooks.onEvent.mockImplementation(() => {
          throw error;
        });
      }
      const settled: string[] = [];
      const failed = (
        kind === "throw"
          ? stream.throw(error)
          : kind === "return-value"
            ? stream.return(Promise.reject(error))
            : stream.next()
      ).catch((rejection: unknown) => {
        expect(rejection).toBe(error);
        settled.push("error");
      });
      const tail = stream.next().then((result) => {
        expect(result).toEqual({ done: true, value: undefined });
        settled.push("done");
      });
      await Promise.all([failed, tail]);
      expect(settled).toEqual(["error", "done"]);
      await stream.return();
      expect(f.source.return).toHaveBeenCalledTimes(
        kind === "source" || kind === "result" || kind === "value" ? 0 : 1,
      );
      expect(f.hooks.onFinally).toHaveBeenCalledOnce();
      expect(f.hooks.onDone).not.toHaveBeenCalled();
    },
  );

  it("queues throw behind a pending read and rejects before later operations", async () => {
    const gate = Promise.withResolvers<IteratorResult<number>>();
    const f = fixture(() => gate.promise);
    const stream = observe(f);
    const error = new Error("consumer");
    const one = stream.next();
    const throwing = expect(stream.throw(error)).rejects.toBe(error);
    const tail = stream.next();
    expect(f.source.return).not.toHaveBeenCalled();
    gate.resolve({ done: false, value: 1 });
    await expect(one).resolves.toEqual({ done: false, value: 1 });
    await throwing;
    await expect(tail).resolves.toEqual({ done: true, value: undefined });
    expect(f.source.return).toHaveBeenCalledOnce();
    expect(f.hooks.onFinally).toHaveBeenCalledOnce();
  });

  it("finishes natural EOF once without closing the exhausted source", async () => {
    const f = fixture(async () => ({ done: true, value: 9 }));
    const stream = observe(f);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    await stream.next();
    await stream.return();
    expect(f.hooks.onStart).toHaveBeenCalledOnce();
    expect(f.hooks.onDone).toHaveBeenCalledOnce();
    expect(f.hooks.onFinally).toHaveBeenCalledOnce();
    expect(f.source.return).not.toHaveBeenCalled();
  });

  it("reports cleanup failure on return, with finalization exactly once", async () => {
    const f = fixture();
    const error = new Error("cleanup");
    f.source.return.mockRejectedValue(error);
    const stream = observe(f);
    await stream.next();
    await expect(stream.return()).rejects.toBe(error);
    await stream.return();
    expect(f.source.return).toHaveBeenCalledOnce();
    expect(f.hooks.onFinally).toHaveBeenCalledOnce();
  });
});
