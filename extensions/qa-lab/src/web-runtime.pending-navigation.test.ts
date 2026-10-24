import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { withPendingWebPage } from "./web-runtime.pending-navigation.test-helper.js";

function pendingFixture() {
  const opening = createDeferred<void>();
  const ready = createDeferred<void>();
  const close = vi.fn<() => void>();
  const verify = vi.fn<() => Promise<void>>();
  const input = { opening: opening.promise, ready: ready.promise, close, verify };
  return { ...input, opening, ready, run: () => withPendingWebPage(input) };
}

it.each([false, true])("settles before readiness (rejects: %s)", async (rejects) => {
  const { opening, close, verify, run } = pendingFixture();
  const openError = new Error("navigation failed"),
    rollback = new Error("rollback failed");
  const primary = new AggregateError([openError, rollback], "open", { cause: openError });
  const cleanup = new AggregateError([rollback], "cleanup failed");
  if (rejects) {
    close.mockImplementation(() => {
      throw cleanup;
    });
    opening.reject(primary);
  } else {
    opening.resolve();
  }
  const failure = await run().catch((error: unknown) => error);
  if (rejects && failure instanceof AggregateError) {
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1]).toBe(cleanup);
    expect(failure.cause).toBe(primary);
  } else if (!rejects && failure instanceof Error) {
    expect(failure.message).toContain("web page acquisition completed before pending navigation");
  } else {
    throw failure;
  }
  expect(verify).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["success", "assertion", "close"])("joins acquisition after %s", async (phase) => {
  const { opening, ready, close, verify, run } = pendingFixture();
  const cancelled = new Error("scenario cancelled");
  const failure = new Error(`${phase} failed`);
  const closing = createDeferred<void>();
  const finished = vi.fn((result: unknown) => result);
  const order: string[] = [];
  verify.mockImplementation(async () => {
    order.push("verify");
    if (phase === "assertion") {
      throw failure;
    }
    if (phase === "success") {
      opening.reject(cancelled);
      await expect(opening.promise).rejects.toBe(cancelled);
    }
  });
  close.mockImplementation(() => {
    order.push("close");
    closing.resolve();
    if (phase === "close") {
      throw failure;
    }
  });
  const pending = run()
    .catch((error: unknown) => error)
    .then(finished);
  try {
    expect(verify).not.toHaveBeenCalled();
    ready.resolve();
    if (phase === "success") {
      await expect(pending).resolves.toBeUndefined();
    } else {
      await Promise.race([
        closing.promise,
        pending.then(() => {
          throw new Error("fixture settled before cancellation");
        }),
      ]);
      await setImmediate();
      expect(close).toHaveBeenCalledOnce();
      expect(finished).not.toHaveBeenCalled();
      opening.reject(cancelled);
      await expect(pending).resolves.toBe(failure);
    }
    expect(verify).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
    expect(order).toEqual(["verify", "close"]);
  } finally {
    ready.resolve();
    opening.reject(cancelled);
    await pending;
  }
});
