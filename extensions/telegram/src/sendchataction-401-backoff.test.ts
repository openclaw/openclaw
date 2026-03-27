import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSendChatActionHandler,
  type CreateTelegramSendChatActionHandlerParams,
} from "./sendchataction-401-backoff.js";

type TelegramSendChatActionTestRuntime = NonNullable<
  CreateTelegramSendChatActionHandlerParams["runtime"]
>;

function createTestRuntime(): TelegramSendChatActionTestRuntime {
  return {
    computeBackoff: vi.fn((_policy, attempt: number) => attempt * 1000),
    sleepWithAbort: vi.fn().mockResolvedValue(undefined),
  };
}

function createHandler(
  params: Omit<CreateTelegramSendChatActionHandlerParams, "runtime"> & {
    runtime?: TelegramSendChatActionTestRuntime;
  },
) {
  const runtime = params.runtime ?? createTestRuntime();
  return {
    runtime,
    handler: createTelegramSendChatActionHandler({
      ...params,
      runtime,
    }),
  };
}

describe("createTelegramSendChatActionHandler", () => {
  const make401Error = () => new Error("401 Unauthorized");
  const makeTransientNetworkError = () =>
    Object.assign(new Error("TypeError: fetch failed"), { code: "ETIMEDOUT" });
  const makeRateLimitError = () => ({
    error_code: 429,
    message: "429 Too Many Requests",
    description: "Too Many Requests: retry after 5",
  });
  const makeServerError = () => ({
    error_code: 502,
    message: "502 Bad Gateway",
    description: "Bad Gateway",
  });
  const makeUnexpectedError = () => new Error("400 Bad Request: invalid action");

  it("calls sendChatActionFn on success", async () => {
    const fn = vi.fn().mockResolvedValue(true);
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
    });

    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledWith(123, "typing", undefined);
    expect(handler.isSuspended()).toBe(false);
  });

  it("applies exponential backoff on consecutive 401 errors", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5,
    });

    // First call fails with 401
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(false);

    // Second call should mention backoff in logs
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("backoff"));
  });

  it("suspends after maxConsecutive401 failures", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");

    expect(handler.isSuspended()).toBe(true);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));

    // Subsequent calls are silently skipped
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(3); // not called again
  });

  it("resets the 401 failure counter on success", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        throw make401Error();
      }
      return Promise.resolve(true);
    });
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    // Third call succeeds
    await handler.sendChatAction(123, "typing");

    expect(handler.isSuspended()).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });

  it("suppresses repeated transient network errors during cooldown", async () => {
    const fn = vi.fn().mockRejectedValue(makeTransientNetworkError());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 2,
    });

    await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();
    await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();

    expect(handler.isSuspended()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("transient failure"));
  });

  it("reset() clears suspension", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 1,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(true);

    handler.reset();
    expect(handler.isSuspended()).toBe(false);
  });

  it("recovers after a transient cooldown expires", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let fail = true;
      const fn = vi.fn().mockImplementation(() => {
        if (fail) {
          fail = false;
          throw makeTransientNetworkError();
        }
        return Promise.resolve(true);
      });
      const logger = vi.fn();
      const { handler } = createHandler({
        sendChatActionFn: fn,
        logger,
      });

      await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();
      now = 10_000;
      await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();

      expect(fn).toHaveBeenCalledTimes(2);
      expect(logger).toHaveBeenCalledWith(expect.stringContaining("recovered"));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("treats Telegram 429 responses as transient and does not suspend", async () => {
    const fn = vi.fn().mockRejectedValue(makeRateLimitError());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
    });

    await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();
    expect(handler.isSuspended()).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("transient failure"));
  });

  it("treats Telegram 5xx responses as transient and does not suspend", async () => {
    const fn = vi.fn().mockRejectedValue(makeServerError());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
    });

    await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();
    expect(handler.isSuspended()).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("transient failure"));
  });

  it("still throws unexpected non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(makeUnexpectedError());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("400 Bad Request");
    expect(handler.isSuspended()).toBe(false);
  });

  it("preserves the 401 failure counter across an intervening transient cooldown", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(make401Error())
        .mockRejectedValueOnce(makeTransientNetworkError())
        .mockRejectedValueOnce(make401Error());
      const logger = vi.fn();
      const { handler } = createHandler({
        sendChatActionFn: fn,
        logger,
        maxConsecutive401: 3,
      });

      await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
      await expect(handler.sendChatAction(123, "typing")).resolves.toBeUndefined();
      now = 10_000;
      await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");

      expect(handler.isSuspended()).toBe(false);
      expect(logger).toHaveBeenCalledWith(expect.stringContaining("401 error (2/3)"));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("is shared across multiple chatIds (global handler)", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const { handler } = createHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    // Different chatIds all contribute to the same failure counter
    await expect(handler.sendChatAction(111, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(222, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(333, "typing")).rejects.toThrow("401");

    expect(handler.isSuspended()).toBe(true);
    // Suspended for all chats
    await handler.sendChatAction(444, "typing");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
