import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  createRetainedOperation,
  finallyRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOutcome,
} from "./retained-operation.js";

describe("retained production combinators", () => {
  it.each([false, true])(
    "maps once in the captured context despite reentrant servicing (throws: %s)",
    async (throws) => {
      const context = new AsyncLocalStorage<string>();
      const source = createRetainedOperation<number>(() => {});
      const failure = new Error("mapping failed");
      const receive = vi.fn((value: number) => {
        expect(context.getStore()).toBe("original");
        operation.service();
        if (throws) {
          throw failure;
        }
        return value * 2;
      });
      const operation = context.run("original", () =>
        mapRetainedOperation(source.operation, receive),
      );
      let reacted = false;
      void operation.result.then(
        () => {
          reacted = true;
        },
        () => {
          reacted = true;
        },
      );
      source.resolve(21);
      context.run("other", () => {
        operation.service();
        operation.service();
        expect(operation.read()).toEqual(
          throws ? { status: "rejected", error: failure } : { status: "fulfilled", value: 42 },
        );
        expect(reacted).toBe(false);
      });
      if (throws) {
        await expect(operation.result).rejects.toBe(failure);
      } else {
        await expect(operation.result).resolves.toBe(42);
      }
      expect(receive).toHaveBeenCalledExactlyOnceWith(21);
    },
  );

  it("adopts a successor once and services it in the captured context without Promise reactions", async () => {
    const context = new AsyncLocalStorage<string>();
    const source = createRetainedOperation<number>(() => {});
    const serviceChild = vi.fn(() => expect(context.getStore()).toBe("original"));
    const child = createRetainedOperation<number>(serviceChild);
    const adopt = vi.fn((value: number) => {
      expect(value).toBe(21);
      expect(context.getStore()).toBe("original");
      return child.operation;
    });
    const joined = context.run("original", () => flatMapRetainedOperation(source.operation, adopt));
    let reacted = false;
    void joined.result.then(() => {
      reacted = true;
    });
    source.resolve(21);
    context.run("other", () => {
      joined.service();
      joined.service();
      expect(joined.read()).toEqual({ status: "pending" });
      expect(adopt).toHaveBeenCalledTimes(1);
      child.resolve(42);
      joined.service();
      expect(joined.read()).toEqual({ status: "fulfilled", value: 42 });
      expect(reacted).toBe(false);
      expect(serviceChild).toHaveBeenCalled();
    });
    await expect(joined.result).resolves.toBe(42);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it.each([
    { cleanupStatus: "fulfilled", original: new Error("original operation failed") },
    { cleanupStatus: "rejected", original: undefined },
  ])(
    "joins $cleanupStatus cleanup before propagating failure without a success continuation",
    async ({ cleanupStatus, original }) => {
      const failed = createRetainedOperation<void>(() => {});
      const cleanup = createRetainedOperation<void>(() => {});
      const adopt = vi.fn((outcome: Exclude<RetainedOutcome<void>, { status: "pending" }>) => {
        expect(outcome).toEqual({ status: "rejected", error: original });
        if (outcome.status === "rejected") {
          expect(outcome.error).toBe(original);
        }
        return cleanup.operation;
      });
      const joined = finallyRetainedOperation(failed.operation, adopt);
      const next = vi.fn(() => cleanup.operation);
      const ordinary = flatMapRetainedOperation(joined, next);
      failed.reject(original);
      joined.service();
      joined.service();
      expect(joined.read()).toEqual({ status: "pending" });
      expect(adopt).toHaveBeenCalledTimes(1);
      const cleanupError = new Error("native cleanup remains pending");
      if (cleanupStatus === "fulfilled") {
        cleanup.resolve(undefined);
      } else {
        cleanup.reject(cleanupError);
      }
      const expected = cleanupStatus === "fulfilled" ? original : cleanupError;
      ordinary.service();
      expect(joined.read()).toEqual({ status: "rejected", error: expected });
      await expect(ordinary.result).rejects.toBe(expected);
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it("joins cleanup after synchronous source servicing throws", async () => {
    const failure = new Error("source servicing failed");
    const source = createRetainedOperation<void>(() => {
      throw failure;
    });
    const cleanup = createRetainedOperation<void>(() => {});
    const adopt = vi.fn(() => cleanup.operation);
    const joined = finallyRetainedOperation(source.operation, adopt);
    expect(joined.read()).toEqual({ status: "pending" });
    expect(adopt).toHaveBeenCalledExactlyOnceWith({ status: "rejected", error: failure });
    cleanup.resolve(undefined);
    joined.service();
    expect(joined.read()).toEqual({ status: "rejected", error: failure });
    await expect(joined.result).rejects.toBe(failure);
  });

  it.each([false, true])(
    "preserves the cleanup error combiner outcome (throws: %s)",
    async (throws) => {
      const source = createRetainedOperation<void>(() => {});
      const cleanup = createRetainedOperation<void>(() => {});
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
    },
  );
});
