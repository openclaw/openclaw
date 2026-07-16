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
  it("matches direct, cause-nested, and error-property-nested conflicts", () => {
    expect(isFeishuReplySessionInitConflictError(CONFLICT_ERROR)).toBe(true);
    expect(
      isFeishuReplySessionInitConflictError(new Error("wrapper", { cause: CONFLICT_ERROR })),
    ).toBe(true);
    expect(
      isFeishuReplySessionInitConflictError(
        new Error("wrapper", { cause: { error: CONFLICT_ERROR } }),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isFeishuReplySessionInitConflictError(new Error("rate limited"))).toBe(false);
    expect(isFeishuReplySessionInitConflictError(undefined)).toBe(false);
  });
});

describe("runFeishuDispatchWithSessionInitConflictRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries conflicts on the 1s/2s/4s ladder and returns the first success", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    const result = runFeishuDispatchWithSessionInitConflictRetry({ dispatch, onRetry });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls).toEqual([
      [1, 1_000],
      [2, 2_000],
    ]);
  });

  it("throws a typed exhausted error carrying the conflict after the ladder is spent", async () => {
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

    await expect(runFeishuDispatchWithSessionInitConflictRetry({ dispatch })).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
