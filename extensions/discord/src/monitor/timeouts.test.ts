// Discord tests cover timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAbortError as runtimeApiIsAbortError,
  normalizeDiscordInboundWorkerTimeoutMs as runtimeApiNormalizeDiscordInboundWorkerTimeoutMs,
  normalizeDiscordListenerTimeoutMs as runtimeApiNormalizeDiscordListenerTimeoutMs,
  runDiscordTaskWithTimeout as runtimeApiRunDiscordTaskWithTimeout,
} from "../../runtime-api.js";
import {
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
  isAbortError,
  normalizeDiscordInboundWorkerTimeoutMs,
  normalizeDiscordListenerTimeoutMs,
  raceWithTimeout,
  runDiscordTaskWithTimeout,
  withAbortTimeout,
} from "./timeouts.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function withNativeAbortSignalAnyDisabled<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(AbortSignal, "any", descriptor);
    } else {
      delete (AbortSignal as { any?: unknown }).any;
    }
  }
}

function findRegisteredAbortListener(addListenerSpy: {
  mock: {
    calls: ReadonlyArray<
      readonly [string, EventListenerOrEventListenerObject | null, ...unknown[]]
    >;
  };
}) {
  const listener = addListenerSpy.mock.calls.find(([type]) => type === "abort")?.[1];
  if (typeof listener !== "function") {
    throw new Error("Expected fallback abort listener to be registered");
  }
  return listener;
}

describe("discord monitor timeouts", () => {
  it("keeps deprecated timeout helpers on the runtime api compatibility surface", () => {
    expect(runtimeApiIsAbortError).toBe(isAbortError);
    expect(runtimeApiNormalizeDiscordInboundWorkerTimeoutMs).toBe(
      normalizeDiscordInboundWorkerTimeoutMs,
    );
    expect(runtimeApiNormalizeDiscordListenerTimeoutMs).toBe(normalizeDiscordListenerTimeoutMs);
    expect(runtimeApiRunDiscordTaskWithTimeout).toBe(runDiscordTaskWithTimeout);
  });

  it("preserves legacy timeout normalization semantics", () => {
    expect(normalizeDiscordListenerTimeoutMs(undefined)).toBe(DISCORD_DEFAULT_LISTENER_TIMEOUT_MS);
    expect(normalizeDiscordListenerTimeoutMs(0)).toBe(DISCORD_DEFAULT_LISTENER_TIMEOUT_MS);
    expect(normalizeDiscordListenerTimeoutMs(250)).toBe(1_000);
    expect(normalizeDiscordListenerTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);

    expect(normalizeDiscordInboundWorkerTimeoutMs(undefined)).toBe(
      DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
    );
    expect(normalizeDiscordInboundWorkerTimeoutMs(0)).toBeUndefined();
    expect(normalizeDiscordInboundWorkerTimeoutMs(-1)).toBe(
      DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
    );
    expect(normalizeDiscordInboundWorkerTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("identifies abort errors for deprecated timeout compatibility callers", () => {
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
  });

  it("caps runDiscordTaskWithTimeout timers before arming the watchdog", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const onTimeout = vi.fn();
    let receivedSignal: AbortSignal | undefined;

    const task = runDiscordTaskWithTimeout({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      onTimeout,
      run: async (signal) => {
        receivedSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);

    await expect(task).resolves.toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("disposes fallback merged abort listeners after completed timeout races settle", async () => {
    await withNativeAbortSignalAnyDisabled(async () => {
      const parentAbortController = new AbortController();
      const addListenerSpy = vi.spyOn(parentAbortController.signal, "addEventListener");
      const removeListenerSpy = vi.spyOn(parentAbortController.signal, "removeEventListener");
      const mergedAbortSpy = vi.fn();
      const onTimeout = vi.fn();
      let receivedSignal: AbortSignal | undefined;

      await expect(
        runDiscordTaskWithTimeout({
          timeoutMs: 1_000,
          abortSignals: [parentAbortController.signal],
          onTimeout,
          run: async (signal) => {
            receivedSignal = signal;
            signal?.addEventListener("abort", mergedAbortSpy);
          },
        }),
      ).resolves.toBe(false);

      const fallbackAbortListener = findRegisteredAbortListener(addListenerSpy);
      expect(removeListenerSpy.mock.calls).toContainEqual(["abort", fallbackAbortListener]);

      parentAbortController.abort();

      expect(onTimeout).not.toHaveBeenCalled();
      expect(receivedSignal?.aborted).toBe(false);
      expect(mergedAbortSpy).not.toHaveBeenCalled();
    });
  });

  it("does not refire fallback merged abort listeners after timeout races settle", async () => {
    await withNativeAbortSignalAnyDisabled(async () => {
      vi.useFakeTimers();
      const parentAbortController = new AbortController();
      const addListenerSpy = vi.spyOn(parentAbortController.signal, "addEventListener");
      const removeListenerSpy = vi.spyOn(parentAbortController.signal, "removeEventListener");
      const mergedAbortSpy = vi.fn();
      const onTimeout = vi.fn();
      let receivedSignal: AbortSignal | undefined;

      const task = runDiscordTaskWithTimeout({
        timeoutMs: 10,
        abortSignals: [parentAbortController.signal],
        onTimeout,
        run: async (signal) => {
          receivedSignal = signal;
          signal?.addEventListener("abort", mergedAbortSpy);
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(task).resolves.toBe(true);
      const fallbackAbortListener = findRegisteredAbortListener(addListenerSpy);
      expect(removeListenerSpy.mock.calls).toContainEqual(["abort", fallbackAbortListener]);
      expect(receivedSignal?.aborted).toBe(true);
      expect(mergedAbortSpy).toHaveBeenCalledTimes(1);

      parentAbortController.abort();

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(mergedAbortSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("caps raceWithTimeout timers before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      raceWithTimeout({
        promise: Promise.resolve("ok"),
        timeoutMs: Number.MAX_SAFE_INTEGER,
        onTimeout: () => "timeout",
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("caps withAbortTimeout timers before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      withAbortTimeout({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        createTimeoutError: () => new Error("timed out"),
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
