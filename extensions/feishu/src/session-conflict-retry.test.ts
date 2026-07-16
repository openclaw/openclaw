// Feishu tests cover the session-init conflict matcher and bounded retry ladder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeishuSessionConflictExhaustedError,
  isFeishuReplySessionInitConflictError,
  runFeishuDispatchWithSessionInitConflictRetry,
} from "./session-conflict-retry.js";

const CONFLICT_ERROR = new Error(
  "reply session initialization conflicted for agent:main:feishu:direct:ou_sender_1",
);

describe("isFeishuReplySessionInitConflictError", () => {
  it("matches direct conflict error message", () => {
    expect(isFeishuReplySessionInitConflictError(CONFLICT_ERROR)).toBe(true);
  });

  it("matches cause-nested conflict errors", () => {
    expect(
      isFeishuReplySessionInitConflictError(new Error("wrapper", { cause: CONFLICT_ERROR })),
    ).toBe(true);
  });

  it("matches error-property-nested conflict errors", () => {
    expect(
      isFeishuReplySessionInitConflictError(
        new Error("wrapper", { cause: { error: CONFLICT_ERROR } }),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isFeishuReplySessionInitConflictError(new Error("rate limited"))).toBe(false);
  });

  it("rejects null/undefined/empty input safely", () => {
    expect(isFeishuReplySessionInitConflictError(undefined)).toBe(false);
    expect(isFeishuReplySessionInitConflictError(null)).toBe(false);
    expect(isFeishuReplySessionInitConflictError("")).toBe(false);
  });
});

describe("runFeishuDispatchWithSessionInitConflictRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result immediately when dispatch succeeds on first attempt", async () => {
    const dispatch = vi.fn().mockResolvedValue("ok");
    await expect(runFeishuDispatchWithSessionInitConflictRetry({ dispatch })).resolves.toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retries conflicts on the 1s/2s/4s ladder and returns the first success", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const result = runFeishuDispatchWithSessionInitConflictRetry({ dispatch, onRetry });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls).toEqual([
      [1, 1_000],
      [2, 2_000],
    ]);
  });

  it("throws a typed exhausted error after all retry delays are spent", async () => {
    const dispatch = vi.fn().mockRejectedValue(CONFLICT_ERROR);

    const result = runFeishuDispatchWithSessionInitConflictRetry({ dispatch });
    const rejection = result.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(7_000);
    const err = await rejection;
    expect(err).toBeInstanceOf(FeishuSessionConflictExhaustedError);
    expect((err as FeishuSessionConflictExhaustedError).cause).toBe(CONFLICT_ERROR);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("rethrows non-conflict failures without retrying", async () => {
    const failure = new Error("feishu api unavailable");
    const dispatch = vi.fn().mockRejectedValue(failure);

    await expect(runFeishuDispatchWithSessionInitConflictRetry({ dispatch })).rejects.toThrow(
      "feishu api unavailable",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with attempt number and delay for each retry", async () => {
    const dispatch = vi.fn().mockRejectedValue(CONFLICT_ERROR);
    const onRetry = vi.fn();
    const result = runFeishuDispatchWithSessionInitConflictRetry({ dispatch, onRetry });
    const rejection = result.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(7_000);
    const err = await rejection;
    expect(err).toBeInstanceOf(FeishuSessionConflictExhaustedError);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls).toEqual([
      [1, 1_000],
      [2, 2_000],
      [3, 4_000],
    ]);
  });
});
