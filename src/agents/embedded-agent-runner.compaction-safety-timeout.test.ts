import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindContextEngineCompaction,
  inheritRuntimeCompactionDelegate,
  markRuntimeCompactionDelegate,
} from "../context-engine/compaction-watchdog.js";
import { isRuntimeCompactionDelegate } from "../context-engine/delegate.js";
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
  it("aborts on caller cancellation and invokes onCancel once", async () => {
    const controller = new AbortController();
    const onCancel = vi.fn();
    const reason = new Error("request timed out");
    const pending = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 100, {
      abortSignal: controller.signal,
      onCancel,
    });
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
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

  it.each([false, true])(
    "captures the compactor receiver and child parameters (marked=%s)",
    async (marked) => {
      const error = new Error("engine compaction failed");
      const compact = vi.fn(function (
        this: { result: CompactResult },
        _params: Parameters<CompactFn>[0],
      ) {
        return marked ? Promise.reject(error) : Promise.resolve(this.result);
      });
      const replacement = vi.fn<CompactFn>(async () => {
        throw new Error("replacement compactor invoked");
      });
      const captured = marked ? markRuntimeCompactionDelegate(compact) : compact;
      let reads = 0;
      const engine = {
        result,
        get compact() {
          return ++reads === 1 ? captured : replacement;
        },
      };
      const bound = bindContextEngineCompaction(engine);
      const forward = vi.fn<CompactFn>((params) => bound(params));
      const ownedCompact = inheritRuntimeCompactionDelegate(bound, forward);
      const controller = new AbortController();
      const runtimeContext = { tokenBudget: 100_000 };
      const request = { ...baseParams, runtimeContext };
      const pending = compactContextEngineWithSafetyTimeout(
        makeEngine(ownedCompact),
        request,
        30,
        controller.signal,
      );
      if (marked) {
        await expect(pending).rejects.toBe(error);
      } else {
        await expect(pending).resolves.toBe(result);
      }
      expect(reads).toBe(1);
      expect(compact).toHaveBeenCalledOnce();
      expect(compact.mock.contexts[0]).toBe(engine);
      expect(replacement).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledOnce();
      const params = forward.mock.calls[0]?.[0];
      expect(compact.mock.calls[0]?.[0]).toBe(params);
      expect(params).toMatchObject(request);
      expect(params).not.toBe(request);
      expect(params?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(params?.abortSignal).not.toBe(controller.signal);
      expect(params?.abortSignal?.aborted).toBe(false);
      expect(isRuntimeCompactionDelegate(bound)).toBe(marked);
      expect(isRuntimeCompactionDelegate(ownedCompact)).toBe(marked);
      expect(typeof params?.runtimeContext?.compactionTimeoutReset).toBe(
        marked ? "function" : "undefined",
      );
      if (marked) {
        expect(params?.runtimeContext).not.toBe(runtimeContext);
      } else {
        expect(params?.runtimeContext).toBe(runtimeContext);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not start a delegate after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("run aborted before compaction");
    const compact = markRuntimeCompactionDelegate(vi.fn<CompactFn>(async () => result));
    controller.abort(reason);
    await expect(
      compactContextEngineWithSafetyTimeout(makeEngine(compact), baseParams, 30, controller.signal),
    ).rejects.toBe(reason);
    expect(compact).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "honors progress resets only for marked bound compactors (marked=%s)",
    async (marked) => {
      let resolveCompact!: (value: CompactResult) => void;
      let resetTimeout: unknown;
      const compact = vi.fn<CompactFn>((params) => {
        resetTimeout = params.runtimeContext?.compactionTimeoutReset;
        return new Promise<CompactResult>((resolve) => {
          resolveCompact = resolve;
        });
      });
      const bound = bindContextEngineCompaction(
        makeEngine(marked ? markRuntimeCompactionDelegate(compact) : compact),
      );
      const ownedCompact = inheritRuntimeCompactionDelegate(bound, (params) => bound(params));
      const pending = compactContextEngineWithSafetyTimeout(
        makeEngine(ownedCompact),
        baseParams,
        30,
      );
      const assertion = marked
        ? expect(pending).resolves.toBe(result)
        : expect(pending).rejects.toThrow("Compaction timed out");
      await vi.advanceTimersByTimeAsync(20);
      expect(typeof resetTimeout).toBe(marked ? "function" : "undefined");
      if (typeof resetTimeout === "function") {
        resetTimeout();
      }
      await vi.advanceTimersByTimeAsync(20);
      resolveCompact(result);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
