import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeTelegramToolProgressDraft } from "./native-tool-progress-draft.js";

describe("createNativeTelegramToolProgressDraft", () => {
  const createSendMessageDraftMock = (implementation?: () => Promise<unknown>) =>
    vi.fn(
      async (
        _chatId: number | string,
        _draftId: number,
        _text?: string,
        _params?: Record<string, unknown>,
      ) => implementation?.(),
    );

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined when the Bot API client has no sendMessageDraft method", () => {
    const draft = createNativeTelegramToolProgressDraft({
      api: {},
      chatId: 123,
    } as never);

    expect(draft).toBeUndefined();
  });

  it("updates the same non-zero draft id for animated native progress", async () => {
    const sendMessageDraft = createSendMessageDraftMock();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      thread: { id: 456, scope: "dm" },
    } as never);

    expect(draft).toBeDefined();
    await draft?.update("Running command");

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    const firstDraftId = sendMessageDraft.mock.calls[0]?.[1];
    expect(firstDraftId).toEqual(expect.any(Number));
    expect(firstDraftId).not.toBe(0);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      123,
      firstDraftId,
      "Running command",
      {
        message_thread_id: 456,
      },
      expect.any(AbortSignal),
    );
  });

  it("stops after a Telegram rejection so later updates can fall back silently", async () => {
    const sendMessageDraft = createSendMessageDraftMock(async () => {
      throw new Error("Bad Request: method is unavailable");
    });
    const log = vi.fn();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      log,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Running command")).resolves.toBe(true);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled")));
    await expect(draft?.update("Still running")).resolves.toBe(false);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid progress updates into the latest pending native draft", async () => {
    vi.useFakeTimers();
    const sendMessageDraft = createSendMessageDraftMock();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      minUpdateIntervalMs: 1_000,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    await expect(draft?.update("Reading files")).resolves.toBe(true);
    await expect(draft?.update("Running tests")).resolves.toBe(true);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    const draftId = sendMessageDraft.mock.calls[0]?.[1];
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      123,
      draftId,
      "Running tests",
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("flushes the latest native draft update after a short quiet window", async () => {
    vi.useFakeTimers();
    const sendMessageDraft = createSendMessageDraftMock();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    await expect(draft?.update("Running checks")).resolves.toBe(true);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_199);
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      123,
      expect.any(Number),
      "Running checks",
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("forces an occasional native draft refresh when progress never goes quiet", async () => {
    vi.useFakeTimers();
    const sendMessageDraft = createSendMessageDraftMock();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      idleUpdateDelayMs: 1_200,
      minUpdateIntervalMs: 5_000,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    await expect(draft?.update("Step 1")).resolves.toBe(true);

    for (let index = 2; index <= 5; index += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(draft?.update(`Step ${index}`)).resolves.toBe(true);
      expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    }

    await vi.advanceTimersByTimeAsync(999);
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      123,
      expect.any(Number),
      "Step 5",
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("does not send overlapping native draft updates while a prior update is in flight", async () => {
    vi.useFakeTimers();
    let resolveFirstSend: ((value: unknown) => void) | undefined;
    const sendMessageDraft = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSend = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      minUpdateIntervalMs: 1_000,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    await expect(draft?.update("Running tests")).resolves.toBe(true);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    resolveFirstSend?.(undefined);
    await vi.waitFor(() => expect(sendMessageDraft).toHaveBeenCalledTimes(2));
    const draftId = sendMessageDraft.mock.calls[0]?.[1];
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      123,
      draftId,
      "Running tests",
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("cancels queued native draft updates when stopped", async () => {
    vi.useFakeTimers();
    const sendMessageDraft = createSendMessageDraftMock();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      minUpdateIntervalMs: 1_000,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    await expect(draft?.update("Running tests")).resolves.toBe(true);
    draft?.stop();

    await vi.runAllTimersAsync();

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight native draft update when stopped", async () => {
    let inFlightSignal: AbortSignal | undefined;
    const sendMessageDraft = vi.fn(
      async (
        _chatId: number | string,
        _draftId: number,
        _text?: string,
        _params?: Record<string, unknown>,
        signal?: AbortSignal,
      ) => {
        inFlightSignal = signal;
        return await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    );
    const log = vi.fn();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      log,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    draft?.stop();

    await vi.waitFor(() => expect(inFlightSignal?.aborted).toBe(true));
    expect(inFlightSignal?.aborted).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not make callers wait for slow native draft network sends", async () => {
    let resolveSend: ((value: unknown) => void) | undefined;
    const sendMessageDraft = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Starting")).resolves.toBe(true);
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    resolveSend?.(undefined);
  });
});
