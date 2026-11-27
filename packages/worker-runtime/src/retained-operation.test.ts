import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import {
  createRetainedOperation,
  finallyRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
} from "./retained-operation.js";

const pending = <T>() => createRetainedOperation<T>(() => {});
const context = new AsyncLocalStorage<string>();
const failure = new Error("operation failed");
const cleanupError = new Error("cleanup failed");
const combined = new Error("combined failure");
const fail = (error: unknown): never => {
  throw error;
};

it.each([false, true])("maps once under reentrancy in captured context: %s", async (throws) => {
  const source = pending<number>();
  const receive = vi.fn((value: number) => {
    expect(context.getStore()).toBe("original");
    operation.service();
    return throws ? fail(failure) : value * 2;
  });
  const operation = context.run("original", () => mapRetainedOperation(source.operation, receive));
  const reacted = vi.fn();
  void operation.result.then(reacted, reacted);
  source.resolve(21);
  context.run("other", () => {
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
  const adopt = vi.fn(() => {
    expect(context.getStore()).toBe("original");
    return child.operation;
  });
  const joined = context.run("original", () => flatMapRetainedOperation(source.operation, adopt));
  const reacted = vi.fn();
  void joined.result.then(reacted);
  source.resolve(21);
  context.run("other", () => {
    joined.service();
    expect(joined.read()).toEqual({ status: "pending" });
    child.resolve(42);
    joined.service();
    expect(joined.read()).toEqual({ status: "fulfilled", value: 42 });
    expect(reacted).not.toHaveBeenCalled();
    expect(serviceChild).toHaveBeenCalled();
  });
  await expect(joined.result).resolves.toBe(42);
  expect(adopt).toHaveBeenCalledExactlyOnceWith(21);
});

it.each(["reject", "undefined", "service"] as const)("joins cleanup: %s", async (mode) => {
  const original = mode === "undefined" ? undefined : failure;
  const failed = createRetainedOperation<void>(() => mode === "service" && fail(original));
  const cleanup = pending<void>();
  const adopt = vi.fn(() => cleanup.operation);
  const joined = finallyRetainedOperation(failed.operation, adopt);
  if (mode !== "service") {
    failed.reject(original);
    joined.service();
  }
  expect(joined.read()).toEqual({ status: "pending" });
  const next = vi.fn(() => cleanup.operation);
  const ordinary = flatMapRetainedOperation(joined, next);
  if (mode === "undefined") {
    cleanup.reject(cleanupError);
  } else {
    cleanup.resolve(undefined);
  }
  const expected = mode === "undefined" ? cleanupError : original;
  ordinary.service();
  expect(joined.read()).toEqual({ status: "rejected", error: expected });
  await expect(ordinary.result).rejects.toBe(expected);
  expect(adopt).toHaveBeenCalledExactlyOnceWith({ status: "rejected", error: original });
  expect(next).not.toHaveBeenCalled();
});

it.each([false, true])("preserves cleanup error combination (throws: %s)", async (throws) => {
  const source = pending<void>();
  const cleanup = pending<void>();
  const combine = vi.fn(() => (throws ? fail(combined) : combined));
  source.reject(failure);
  cleanup.reject(cleanupError);
  const joined = finallyRetainedOperation(source.operation, () => cleanup.operation, combine);
  expect(joined.read()).toEqual({ status: "rejected", error: combined });
  await expect(joined.result).rejects.toBe(combined);
  expect(combine).toHaveBeenCalledExactlyOnceWith(failure, cleanupError);
});
