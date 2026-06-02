import { describe, expect, it, vi } from "vitest";
import { abortable as abortableWithSignal } from "./abortable.js";

/**
 * Reproduces the minimal composition of promptActiveSession to prove
 * the pre-abort guard prevents activeSession.prompt() from being called
 * when the run signal is already aborted. See #74859.
 */

function buildPromptActiveSession(params: {
  runAbortController: AbortController;
  promptFn: (prompt: string) => Promise<void>;
  trackPromptSettlePromise: (p: Promise<void>) => Promise<void>;
}) {
  const { runAbortController, promptFn, trackPromptSettlePromise } = params;
  const abortable = <T>(promise: Promise<T>): Promise<T> =>
    abortableWithSignal(runAbortController.signal, promise);

  return (prompt: string): Promise<void> => {
    // Mirrors the production guard in attempt.ts promptActiveSession
    if (runAbortController.signal.aborted) {
      const reason = runAbortController.signal.reason;
      const err =
        reason instanceof Error
          ? new Error(reason.message, { cause: reason })
          : reason
            ? new Error("aborted", { cause: reason })
            : new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    return abortable(trackPromptSettlePromise(promptFn(prompt)));
  };
}

describe("promptActiveSession pre-abort guard (#74859)", () => {
  it("skips prompt() when signal is already aborted — zero LLM calls", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user stop"));

    const promptFn = vi.fn(async () => {});
    const promptActiveSession = buildPromptActiveSession({
      runAbortController: controller,
      promptFn,
      trackPromptSettlePromise: (p) => p,
    });

    await expect(promptActiveSession("hello")).rejects.toMatchObject({
      name: "AbortError",
      message: "user stop",
    });
    expect(promptFn).not.toHaveBeenCalled();
  });

  it("preserves abort reason as cause", async () => {
    const controller = new AbortController();
    const cause = new Error("timeout reached");
    controller.abort(cause);

    const promptActiveSession = buildPromptActiveSession({
      runAbortController: controller,
      promptFn: vi.fn(async () => {}),
      trackPromptSettlePromise: (p) => p,
    });

    const err = await promptActiveSession("hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).cause).toBe(cause);
  });

  it("calls prompt() normally when signal is not aborted", async () => {
    const controller = new AbortController();
    const promptFn = vi.fn(async () => {});

    const promptActiveSession = buildPromptActiveSession({
      runAbortController: controller,
      promptFn,
      trackPromptSettlePromise: (p) => p,
    });

    await promptActiveSession("hello");
    expect(promptFn).toHaveBeenCalledWith("hello");
  });

  it("without guard: prompt() would be called even with pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user stop"));

    const promptFn = vi.fn(async (_prompt: string) => {});
    const abortable = <T>(promise: Promise<T>): Promise<T> =>
      abortableWithSignal(controller.signal, promise);

    // This simulates the OLD code path without the guard:
    // abortable(trackPromptSettlePromise(promptFn(prompt)))
    // JS evaluates promptFn() BEFORE abortable() can reject.
    const oldStylePrompt = (prompt: string) => abortable(promptFn(prompt));

    await expect(oldStylePrompt("hello")).rejects.toMatchObject({ name: "AbortError" });
    // The bug: promptFn WAS called despite the signal being aborted
    expect(promptFn).toHaveBeenCalledTimes(1);
  });
});
