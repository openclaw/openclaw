import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout as compactEngine,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./embedded-agent-runner/compaction-safety-timeout.js";

type CompactFn = ContextEngine["compact"];
const baseParams = { sessionId: "session-1", sessionKey: "agent:main:session-1" };
const result: CompactResult = { ok: true, compacted: true };
function startCompaction(acceptedHostParams?: string[], abortSignal?: AbortSignal) {
  const completion = createDeferred<CompactResult>();
  const compact = vi.fn<CompactFn>(() => completion.promise);
  const engine = {
    compact,
    info: { id: "test", name: "Test", ownsCompaction: false, acceptedHostParams },
  };
  const pending = compactEngine(engine, baseParams, 30, abortSignal);
  return { completion, compact, pending, params: () => compact.mock.calls[0]?.[0] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  const timers = vi.getTimerCount();
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(timers).toBe(0);
});

it.each([true, false, undefined])("keeps progress opt-in (capability=%s)", async (reporting) => {
  const acceptedHostParams = reporting === undefined ? undefined : reporting ? ["onProgress"] : [];
  const { compact, completion, pending, params } = startCompaction(acceptedHostParams);
  const signal = params()?.abortSignal;
  expect(compact).toHaveBeenCalledOnce();
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  if (reporting) {
    expect(params()?.onProgress).toBeTypeOf("function");
  } else {
    expect(params()).not.toHaveProperty("onProgress");
  }
  const assertion = reporting
    ? expect(pending).resolves.toBe(result)
    : expect(pending).rejects.toThrow("Compaction timed out");

  for (let tick = 0; tick < 2; tick++) {
    await vi.advanceTimersByTimeAsync(20);
    params()?.onProgress?.();
  }
  await vi.advanceTimersByTimeAsync(20);
  completion.resolve(result);
  await assertion;
  expect(signal?.aborted).toBe(!reporting);
  if (!reporting) {
    expect(signal?.reason).toEqual(new Error("Compaction timed out"));
  }
});

it("bounds reporting plugins at the existing overall ceiling", async () => {
  const { pending, params } = startCompaction(["onProgress"]);
  const signal = params()?.abortSignal;
  const assertion = expect(pending).rejects.toThrow("Compaction timed out");
  for (let elapsed = 0; elapsed < 280; elapsed += 20) {
    await vi.advanceTimersByTimeAsync(20);
    params()?.onProgress?.();
  }
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  await assertion;
  expect(signal?.aborted).toBe(true);
  params()?.onProgress?.();
});

it("treats a caller-supplied deadlineAt as epoch ms", async () => {
  let signal: AbortSignal | undefined;
  const pending = compactWithSafetyTimeout(
    (abortSignal) => {
      signal = abortSignal;
      return new Promise<never>(() => {});
    },
    30,
    { deadlineAt: Date.now() + 20 },
  );
  const settled = pending.catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  // Subtracting a monotonic timestamp from this epoch value would leave the budget at
  // decades, so the caller's 20ms ceiling would be enforced as the whole 30ms window.
  await vi.advanceTimersByTimeAsync(20);
  expect(signal?.aborted).toBe(true);
  expect(await settled).toBe("Compaction timed out");
});

it("retains the default timeout when cancellation cleanup throws", async () => {
  const onCancel = vi.fn(() => {
    throw new Error("abortCompaction failed");
  });
  const pending = compactWithSafetyTimeout(() => new Promise<never>(() => {}), undefined, {
    onCancel,
  });
  const assertion = expect(pending).rejects.toThrow("Compaction timed out");
  await vi.advanceTimersByTimeAsync(180_000);
  await assertion;
  expect(onCancel).toHaveBeenCalledOnce();
});

it.each([
  [undefined, 180_000],
  [1800.7, 1_800_000],
])("resolves configured timeout seconds %s", (seconds, expected) => {
  const config =
    seconds === undefined
      ? undefined
      : { agents: { defaults: { compaction: { timeoutSeconds: seconds } } } };
  expect(resolveCompactionTimeoutMs(config)).toBe(expected);
});

it("does not start an engine after caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted before compaction");
  controller.abort(reason);
  const { compact, pending } = startCompaction(undefined, controller.signal);
  await expect(pending).rejects.toBe(reason);
  expect(compact).not.toHaveBeenCalled();
});

it("threads caller cancellation into the plugin compactor", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted");
  const { compact, pending, params } = startCompaction(undefined, controller.signal);
  const signal = params()?.abortSignal;
  const assertion = expect(pending).rejects.toBe(reason);
  expect(compact).toHaveBeenCalledOnce();
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  controller.abort(reason);
  await assertion;
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toBe(reason);
});
