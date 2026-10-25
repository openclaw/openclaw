import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import {
  createRetainedOperation,
  finallyRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOutcome,
} from "./retained-operation.js";

const pending = <T>() => createRetainedOperation<T>(() => {});
const context = new AsyncLocalStorage<string>();

it.each([false, true])("maps once under reentrancy in captured context: %s", async (throws) => {
  const source = pending<number>();
  const failure = new Error("mapping failed");
  const receive = vi.fn((value: number) => {
    expect(context.getStore()).toBe("original");
    operation.service();
    if (throws) {
      throw failure;
    }
    return value * 2;
  });
  const operation = context.run("original", () => mapRetainedOperation(source.operation, receive));
  const reacted = vi.fn();
  void operation.result.then(reacted, reacted);
  source.resolve(21);
  context.run("other", () => {
    operation.service();
    operation.service();
    expect(operation.read()).toEqual(
      throws ? { status: "rejected", error: failure } : { status: "fulfilled", value: 42 },
    );
    expect(reacted).not.toHaveBeenCalled();
  });
  await expect(operation.result)[throws ? "rejects" : "resolves"].toBe(throws ? failure : 42);
  expect(receive).toHaveBeenCalledExactlyOnceWith(21);
});

it("adopts once and services in captured context before Promise reactions", async () => {
  const source = pending<number>();
  const serviceChild = vi.fn(() => expect(context.getStore()).toBe("original"));
  const child = createRetainedOperation<number>(serviceChild);
  const adopt = vi.fn((value: number) => {
    expect(value).toBe(21);
    expect(context.getStore()).toBe("original");
    return child.operation;
  });
  const joined = context.run("original", () => flatMapRetainedOperation(source.operation, adopt));
  const reacted = vi.fn();
  void joined.result.then(reacted);
  source.resolve(21);
  context.run("other", () => {
    joined.service();
    joined.service();
    expect(joined.read()).toEqual({ status: "pending" });
    expect(adopt).toHaveBeenCalledTimes(1);
    child.resolve(42);
    joined.service();
    expect(joined.read()).toEqual({ status: "fulfilled", value: 42 });
    expect(reacted).not.toHaveBeenCalled();
    expect(serviceChild).toHaveBeenCalled();
  });
  await expect(joined.result).resolves.toBe(42);
  expect(adopt).toHaveBeenCalledTimes(1);
});

it.each([
  { original: new Error("original operation failed"), cleanupRejects: false, sourceThrows: false },
  { original: undefined, cleanupRejects: true, sourceThrows: false },
  { original: new Error("source servicing failed"), cleanupRejects: false, sourceThrows: true },
] as const)(
  "joins cleanup before failure: %j",
  async ({ original, cleanupRejects, sourceThrows }) => {
    const failed = createRetainedOperation<void>(() => {
      if (sourceThrows) {
        throw original;
      }
    });
    const cleanup = pending<void>();
    const adopt = vi.fn((outcome: Exclude<RetainedOutcome<void>, { status: "pending" }>) => {
      expect(outcome.status === "rejected" && outcome.error).toBe(original);
      return cleanup.operation;
    });
    const joined = finallyRetainedOperation(failed.operation, adopt);
    if (!sourceThrows) {
      failed.reject(original);
      joined.service();
      joined.service();
    }
    expect(joined.read()).toEqual({ status: "pending" });
    expect(adopt).toHaveBeenCalledExactlyOnceWith({ status: "rejected", error: original });
    const next = vi.fn(() => cleanup.operation);
    const ordinary = flatMapRetainedOperation(joined, next);
    const cleanupError = new Error("native cleanup remains pending");
    if (cleanupRejects) {
      cleanup.reject(cleanupError);
    } else {
      cleanup.resolve(undefined);
    }
    const expected = cleanupRejects ? cleanupError : original;
    ordinary.service();
    expect(joined.read()).toEqual({ status: "rejected", error: expected });
    await expect(ordinary.result).rejects.toBe(expected);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  },
);

it.each([false, true])("preserves cleanup error combination (throws: %s)", async (throws) => {
  const source = pending<void>();
  const cleanup = pending<void>();
  const sourceError = new Error("source failed");
  const cleanupError = new Error("cleanup failed");
  const combined = new Error("combined failure");
  const combine = vi.fn(() => {
    if (throws) {
      throw combined;
    }
    return combined;
  });
  source.reject(sourceError);
  cleanup.reject(cleanupError);
  const joined = finallyRetainedOperation(source.operation, () => cleanup.operation, combine);
  expect(joined.read()).toEqual({ status: "rejected", error: combined });
  await expect(joined.result).rejects.toBe(combined);
  expect(combine).toHaveBeenCalledExactlyOnceWith(sourceError, cleanupError);
});
