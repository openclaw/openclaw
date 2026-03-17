import { describe, expect, it, vi } from "vitest";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
vi.mock("../../../src/infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sleepWithAbort: vi.fn().mockResolvedValue(void 0)
  };
});
describe("createTelegramSendChatActionHandler", () => {
  const make401Error = () => new Error("401 Unauthorized");
  const make500Error = () => new Error("500 Internal Server Error");
  it("calls sendChatActionFn on success", async () => {
    const fn = vi.fn().mockResolvedValue(true);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger
    });
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledWith(123, "typing", void 0);
    expect(handler.isSuspended()).toBe(false);
  });
  it("applies exponential backoff on consecutive 401 errors", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5
    });
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(false);
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("backoff"));
  });
  it("suspends after maxConsecutive401 failures", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3
    });
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(true);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("resets failure counter on success", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        throw make401Error();
      }
      return Promise.resolve(true);
    });
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5
    });
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await handler.sendChatAction(123, "typing");
    expect(handler.isSuspended()).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });
  it("does not count non-401 errors toward suspension", async () => {
    const fn = vi.fn().mockRejectedValue(make500Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 2
    });
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    expect(handler.isSuspended()).toBe(false);
  });
  it("reset() clears suspension", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 1
    });
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(true);
    handler.reset();
    expect(handler.isSuspended()).toBe(false);
  });
  it("is shared across multiple chatIds (global handler)", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3
    });
    await expect(handler.sendChatAction(111, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(222, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(333, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(true);
    await handler.sendChatAction(444, "typing");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
