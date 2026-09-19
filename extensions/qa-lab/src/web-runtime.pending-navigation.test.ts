import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { withPendingWebPage } from "./web-runtime.pending-navigation.test-helper.js";

describe("QA web pending-navigation fixture", () => {
  it("propagates the original launch failure without waiting for a request", async () => {
    const error = new Error("browser launch failed");
    const ready = createDeferred<void>();
    const close = vi.fn();
    const verify = vi.fn();

    await expect(
      withPendingWebPage({
        opening: Promise.reject(error),
        ready: ready.promise,
        close,
        verify,
      }),
    ).rejects.toBe(error);
    expect(verify).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects acquisition that completes before the request", async () => {
    const ready = createDeferred<void>();
    const close = vi.fn();
    const verify = vi.fn();

    await expect(
      withPendingWebPage({
        opening: Promise.resolve({ pageId: "unexpected-page" }),
        ready: ready.promise,
        close,
        verify,
      }),
    ).rejects.toThrow("web page acquisition completed before pending navigation");
    expect(verify).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs the cancellation assertion only after request readiness", async () => {
    const opening = createDeferred<void>();
    const ready = createDeferred<void>();
    const cancelled = new Error("scenario cancelled");
    const order: string[] = [];
    const verify = vi.fn(async () => {
      order.push("verify");
      opening.reject(cancelled);
      await expect(opening.promise).rejects.toBe(cancelled);
    });
    const pending = withPendingWebPage({
      opening: opening.promise,
      ready: ready.promise,
      close: () => {
        order.push("close");
      },
      verify,
    });
    try {
      expect(verify).not.toHaveBeenCalled();
      ready.resolve();
      await pending;
      expect(verify).toHaveBeenCalledOnce();
      expect(order).toEqual(["verify", "close"]);
    } finally {
      ready.resolve();
      opening.reject(cancelled);
      await pending;
    }
  });

  it.each(["assertion", "close"] as const)(
    "cancels and joins acquisition after %s failure",
    async (phase) => {
      const opening = createDeferred<void>();
      const cancelled = new Error("fixture cancelled");
      const closeError = new Error("fixture close failed");
      const controller = new AbortController();
      const closing = createDeferred<void>();
      const finished = vi.fn();
      let expectedError: unknown = closeError;
      const close = vi.fn(() => {
        controller.abort(cancelled);
        closing.resolve();
        if (phase === "close") {
          throw closeError;
        }
      });
      const pending = withPendingWebPage({
        opening: opening.promise,
        ready: Promise.resolve(),
        close,
        verify: async () => {
          if (phase === "assertion") {
            try {
              expect("actual fixture state").toBe("expected fixture state");
            } catch (error) {
              expectedError = error;
              throw error;
            }
          }
        },
      })
        .catch((error: unknown) => error)
        .then((result) => {
          finished();
          return result;
        });
      try {
        await Promise.race([
          closing.promise,
          pending.then(() => {
            throw new Error("fixture settled before cancellation");
          }),
        ]);
        await setImmediate();
        expect(controller.signal.reason).toBe(cancelled);
        expect(close).toHaveBeenCalledOnce();
        expect(finished).not.toHaveBeenCalled();
        opening.reject(cancelled);
        await expect(pending).resolves.toBe(expectedError);
        expect(finished).toHaveBeenCalledOnce();
      } finally {
        opening.reject(cancelled);
        await pending;
      }
    },
  );

  it.each(["acquisition", "assertion"] as const)(
    "preserves both %s and cleanup failures",
    async (phase) => {
      const opening = createDeferred<void>();
      const ready = createDeferred<void>();
      const acquisitionError = new Error("navigation failed");
      const rollbackError = new Error("rollback failed");
      let primaryFailure: unknown = new AggregateError(
        [acquisitionError, rollbackError],
        "web page open and cleanup failed",
        { cause: acquisitionError },
      );
      const closeError = new AggregateError([rollbackError], "web session cleanup failed");
      const cancelled = new Error("fixture cancelled");
      const close = vi.fn(() => {
        opening.reject(cancelled);
        throw closeError;
      });
      const verify = vi.fn(async () => {
        try {
          expect("actual fixture state").toBe("expected fixture state");
        } catch (error) {
          primaryFailure = error;
          throw error;
        }
      });
      const pending = withPendingWebPage({
        opening: opening.promise,
        ready: ready.promise,
        close,
        verify,
      }).catch((error: unknown) => error);
      try {
        if (phase === "acquisition") {
          opening.reject(primaryFailure);
        } else {
          ready.resolve();
        }
        const failure = (await pending) as AggregateError;
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(primaryFailure);
        expect(failure.errors[1]).toBe(closeError);
        expect(failure.cause).toBe(primaryFailure);
        expect(close).toHaveBeenCalledOnce();
        expect(verify).toHaveBeenCalledTimes(phase === "acquisition" ? 0 : 1);
      } finally {
        opening.reject(cancelled);
        ready.resolve();
        await pending;
      }
    },
  );
});
