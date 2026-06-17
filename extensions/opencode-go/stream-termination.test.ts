// Opencode Go stream termination wrapper tests cover provider-owned raw SSE
// boundary behavior for stalled OpenAI-compatible streams.
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpencodeGoStalledStreamWrapper } from "./stream-termination.js";

type AnyEvent = AssistantMessageEvent;
type StreamLike = AssistantMessageEventStreamContract;

interface FakeStreamController {
  emit(event: AnyEvent): void;
  end(): void;
}

function createFakeBaseStream(): {
  stream: StreamLike;
  controller: FakeStreamController;
} {
  const queued: IteratorResult<AnyEvent>[] = [];
  const waiters: ((result: IteratorResult<AnyEvent>) => void)[] = [];
  let finished = false;

  const iterator: AsyncIterator<AnyEvent> = {
    next(): Promise<IteratorResult<AnyEvent>> {
      if (queued.length > 0) {
        return Promise.resolve(queued.shift()!);
      }
      if (finished) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    return(): Promise<IteratorResult<AnyEvent>> {
      finished = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const stream: StreamLike = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    push() {
      // unused: the wrapper pushes its own events into a separate stream.
    },
    end() {
      // unused: the wrapper ends its own stream.
    },
    result() {
      return Promise.reject(new Error("fake base stream result not used"));
    },
  };

  const controller: FakeStreamController = {
    emit(event: AnyEvent) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queued.push({ value: event, done: false });
      }
    },
    end() {
      finished = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
    },
  };

  return { stream, controller };
}

describe("createOpencodeGoStalledStreamWrapper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts underlying stream when progress stalls after first delta (raw SSE boundary)", async () => {
    // Arrange: a fake base stream that emits a start + one text_delta, then stalls.
    const { stream: baseStream, controller } = createFakeBaseStream();
    void baseStream;
    let abortCalled = false;
    const capturedSignals: AbortSignal[] = [];

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as any, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as any,
        {} as any,
        {} as any,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    // Drain wrapper events in the background.
    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    // Emit a start + one text delta — that proves the provider side has produced tokens.
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stopReason: undefined,
    };
    controller.emit({ type: "start", partial } as any);
    controller.emit({
      type: "text_delta",
      contentIndex: 0,
      delta: "hi",
      partial,
    } as any);

    // Advance wall clock beyond idleTimeoutMs without any new progress.
    await vi.advanceTimersByTimeAsync(6_000);

    // Assert: wrapper called abort on its injected AbortController (forwarded as options.signal).
    expect(capturedSignals).toHaveLength(1);
    expect(abortCalled).toBe(true);

    // And it pushed a terminal error event to the downstream consumer.
    const terminal = received.find(
      (event) => event.type === "error" && (event as any).reason === "aborted",
    );
    expect(terminal).toBeDefined();

    // Cleanup: end base stream so consumer promise resolves.
    controller.end();
    await consumer;
  });

  it("does not abort during slow time-to-first-byte (idle timer arms only after first event)", async () => {
    // Regression for the timer-lifecycle bug: arming the idle timer before
    // the first upstream event would abort slow time-to-first-byte requests
    // (e.g. opencode-go cron runs that deliberately leave the runtime's
    // first-event watchdog uncapped via resolveLlmIdleTimeoutMs). The
    // wrapper must not arm its own idle timer until an upstream event has
    // been observed and forwarded.
    const { stream: baseStream, controller } = createFakeBaseStream();
    void baseStream;
    let abortCalled = false;
    const capturedSignals: AbortSignal[] = [];

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as any, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as any,
        {} as any,
        {} as any,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    // Advance wall clock well beyond idleTimeoutMs WITHOUT any upstream
    // event. The wrapper must not have armed the timer yet.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(abortCalled).toBe(false);
    expect(received).toHaveLength(0);

    // Cleanup
    controller.end();
    await consumer;
  });

  it("preserves normal delayed usage-only completion without aborting", async () => {
    // Arrange: a fake base stream that streams a normal completion, including
    // a long quiet gap before the final usage-only delta — but well within the
    // idle timeout. The wrapper must not abort.
    const { stream: baseStream, controller } = createFakeBaseStream();
    void baseStream;
    let abortCalled = false;
    const capturedSignals: AbortSignal[] = [];

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as any, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as any,
        {} as any,
        {} as any,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
    };
    controller.emit({ type: "start", partial } as any);
    controller.emit({
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial,
    } as any);

    // Simulate a delayed final chunk after a short (sub-timeout) quiet gap.
    await vi.advanceTimersByTimeAsync(2_000);

    // Final completion event arrives before idle timeout fires.
    controller.emit({
      type: "done",
      reason: "stop",
      message: partial,
    } as any);

    // Advance well past the idle timeout — wrapper should NOT have fired.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(abortCalled).toBe(false);

    // Downstream must contain all forwarded events including the done event.
    const doneEvent = received.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();

    // Cleanup
    controller.end();
    await consumer;
  });
});
