import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./embedded-agent-runner/compaction-safety-timeout.js";

type CompactFn = ContextEngine["compact"];
const baseParams: Parameters<CompactFn>[0] = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  tokenBudget: 100_000,
  force: true,
};
const result: CompactResult = {
  ok: true,
  compacted: true,
  result: { tokensBefore: 1000, tokensAfter: 200 },
};
const makeEngine = (compact: CompactFn): Pick<ContextEngine, "compact" | "info"> => ({
  compact,
  info: { id: "test", name: "Test", ownsCompaction: false },
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("compaction safety timeout", () => {
  it.each([
    { acceptedHostParams: ["onProgress"], reporting: true },
    { acceptedHostParams: [], reporting: false },
    { acceptedHostParams: undefined, reporting: false },
  ])("keeps progress opt-in for $acceptedHostParams", async ({ acceptedHostParams, reporting }) => {
    const completion = createDeferred<CompactResult>();
    let receivedParams: Parameters<CompactFn>[0] | undefined;
    const engine = makeEngine((params) => {
      receivedParams = params;
      return completion.promise;
    });
    engine.info.acceptedHostParams = acceptedHostParams;
    const pending = compactContextEngineWithSafetyTimeout(engine, baseParams, 30);
    if (reporting) {
      expect(receivedParams?.onProgress).toBeTypeOf("function");
    } else {
      expect(receivedParams).not.toHaveProperty("onProgress");
    }
    const assertion = reporting
      ? expect(pending).resolves.toBe(result)
      : expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(20);
    receivedParams?.onProgress?.();
    await vi.advanceTimersByTimeAsync(20);
    receivedParams?.onProgress?.();
    await vi.advanceTimersByTimeAsync(20);
    completion.resolve(result);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds reporting plugins at the existing overall ceiling", async () => {
    let progress: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const engine = makeEngine((params) => {
      progress = params.onProgress;
      signal = params.abortSignal;
      return createDeferred<CompactResult>().promise;
    });
    engine.info.acceptedHostParams = ["onProgress"];
    const pending = compactContextEngineWithSafetyTimeout(engine, baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");
    for (let elapsed = 0; elapsed < 280; elapsed += 20) {
      await vi.advanceTimersByTimeAsync(20);
      progress?.();
    }
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(signal?.aborted).toBe(true);
    progress?.();
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { seconds: undefined, expected: 180_000 },
    { seconds: 1800.7, expected: 1_800_000 },
  ])("resolves configured timeout seconds $seconds", ({ seconds, expected }) => {
    expect(
      resolveCompactionTimeoutMs(
        seconds === undefined
          ? undefined
          : { agents: { defaults: { compaction: { timeoutSeconds: seconds } } } },
      ),
    ).toBe(expected);
  });

  it("does not start an engine after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("run aborted before compaction");
    const compact = vi.fn<CompactFn>(async () => result);
    controller.abort(reason);
    await expect(
      compactContextEngineWithSafetyTimeout(makeEngine(compact), baseParams, 30, controller.signal),
    ).rejects.toBe(reason);
    expect(compact).not.toHaveBeenCalled();
  });

  it.each(["caller", "timeout"] as const)(
    "threads %s cancellation into the plugin compactor",
    async (source) => {
      const controller = new AbortController();
      const reason = new Error("run aborted");
      let signal: AbortSignal | undefined;
      const compact = vi.fn<CompactFn>((params) => {
        signal = params.abortSignal;
        return new Promise<CompactResult>(() => {});
      });
      const pending = compactContextEngineWithSafetyTimeout(
        makeEngine(compact),
        baseParams,
        30,
        source === "caller" ? controller.signal : undefined,
      );
      const assertion =
        source === "caller"
          ? expect(pending).rejects.toBe(reason)
          : expect(pending).rejects.toThrow("Compaction timed out");
      expect(compact).toHaveBeenCalledOnce();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      if (source === "caller") {
        controller.abort(reason);
      } else {
        await vi.advanceTimersByTimeAsync(30);
      }
      await assertion;
      expect(signal?.aborted).toBe(true);
      if (source === "caller") {
        expect(signal?.reason).toBe(reason);
      } else {
        expect(signal?.reason).toEqual(new Error("Compaction timed out"));
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
