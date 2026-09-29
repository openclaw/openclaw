import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpencodeGoStalledStreamWrapper } from "./stream-termination.js";

type AnyEvent = AssistantMessageEvent;
type StreamLike = AssistantMessageEventStreamContract;
type ProviderStreamFn = Parameters<typeof createOpencodeGoStalledStreamWrapper>[0];
type ProviderModel = Parameters<ProviderStreamFn>[0];
type ProviderContext = Parameters<ProviderStreamFn>[1];
type ProviderCallOptions = Parameters<ProviderStreamFn>[2];
type ErrorEvent = Extract<AnyEvent, { type: "error" }>;

function asProviderEvent(event: unknown): AnyEvent {
  return event as AnyEvent;
}

function asProviderModel(model: unknown): ProviderModel {
  return model as ProviderModel;
}

interface FakeStreamController {
  emit(event: AnyEvent): void;
  end(): void;
}

function createFakeBaseStream(): {
  stream: StreamLike;
  controller: FakeStreamController;
  getReturnCalls: () => number;
} {
  const queued: IteratorResult<AnyEvent>[] = [];
  const waiters: ((result: IteratorResult<AnyEvent>) => void)[] = [];
  let finished = false;
  let returnCalls = 0;

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
      returnCalls += 1;
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
    push() {},
    end() {},
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

  return { stream, controller, getReturnCalls: () => returnCalls };
}

type StreamHarnessOptions = {
  source?: StreamLike | Promise<StreamLike>;
  model?: ProviderModel;
  callOptions?: ProviderCallOptions;
  idleTimeoutMs?: number;
  firstEventTimeoutMs?: number;
};

async function createStreamHarness(options: StreamHarnessOptions = {}) {
  const base = createFakeBaseStream();
  let abortCalled = false;
  let providerSignal: AbortSignal | undefined;
  const capturedSignals: AbortSignal[] = [];
  const underlying = vi.fn((_model, _context, callOptions) => {
    providerSignal = callOptions?.signal;
    if (providerSignal) {
      capturedSignals.push(providerSignal);
      providerSignal.addEventListener("abort", () => {
        abortCalled = true;
      });
    }
    return options.source ?? base.stream;
  });
  const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
    provider: "opencode-go",
    idleTimeoutMs: options.idleTimeoutMs ?? 5_000,
    ...(options.firstEventTimeoutMs === undefined
      ? {}
      : { firstEventTimeoutMs: options.firstEventTimeoutMs }),
  });
  const downstream = await Promise.resolve(
    wrapper(
      options.model ??
        ({
          api: "openai-completions",
          provider: "opencode-go",
          id: "deepseek-v4-flash",
        } as ProviderModel),
      {} as ProviderContext,
      options.callOptions ?? ({} as ProviderCallOptions),
    ),
  );
  if (!downstream) {
    throw new Error("expected wrapped stream");
  }
  const received: AnyEvent[] = [];
  const consumer = (async () => {
    for await (const event of downstream) {
      received.push(event);
    }
  })();
  return {
    ...base,
    underlying,
    received,
    consumer,
    capturedSignals,
    providerSignal: () => providerSignal,
    wasAborted: () => abortCalled,
  };
}

describe("createOpencodeGoStalledStreamWrapper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts underlying stream when progress stalls after first delta (raw SSE boundary)", async () => {
    const { controller, consumer, received, capturedSignals, wasAborted } =
      await createStreamHarness();
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));
    controller.emit(
      asProviderEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial,
      }),
    );

    await vi.advanceTimersByTimeAsync(6_000);

    expect(capturedSignals).toHaveLength(1);
    expect(wasAborted()).toBe(true);

    const terminal = received.find(
      (event): event is ErrorEvent => event.type === "error" && event.reason === "error",
    );
    expect(terminal).toBeDefined();
    expect(terminal?.error).toMatchObject({
      stopReason: "error",
      errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    });

    controller.end();
    await consumer;
  });

  it("keeps the first-event window after synthetic block-start events until a provider delta", async () => {
    const { controller, consumer, received, wasAborted } = await createStreamHarness({
      firstEventTimeoutMs: 10_000,
    });
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));
    controller.emit(asProviderEvent({ type: "text_start", contentIndex: 0, partial }));

    await vi.advanceTimersByTimeAsync(6_000);
    expect(wasAborted()).toBe(false);

    const message = {
      ...partial,
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
    };
    controller.emit({
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial: message,
    } as AnyEvent);
    controller.emit({ type: "done", reason: "stop", message } as AnyEvent);
    await consumer;

    expect(wasAborted()).toBe(false);
    expect(received.some((event) => event.type === "text_delta")).toBe(true);
    expect(received.some((event) => event.type === "done")).toBe(true);
  });

  it("honors explicit opencode-go provider request timeout above the wrapper idle default", async () => {
    const { controller, consumer, wasAborted } = await createStreamHarness({
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 5_000,
      model: asProviderModel({
        provider: "opencode-go",
        id: "deepseek-v4-flash",
        requestTimeoutMs: 10_000,
      }),
    });
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "slow" }],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));

    await vi.advanceTimersByTimeAsync(6_000);
    expect(wasAborted()).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(wasAborted()).toBe(true);
    await consumer;
  });

  it("preserves the provider-owned first-event timeout when core passes a shorter generic value", async () => {
    const { controller, consumer, underlying } = await createStreamHarness({
      idleTimeoutMs: 120_000,
      firstEventTimeoutMs: 300_000,
      callOptions: { firstEventTimeoutMs: 30_000 } as ProviderCallOptions,
    });
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying.mock.calls[0]?.[2]).toMatchObject({
      firstEventTimeoutMs: 300_000,
    });

    controller.end();
    await consumer;
  });

  it("honors explicit opencode-go provider request timeout below wrapper defaults", async () => {
    const { consumer, wasAborted } = await createStreamHarness({
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 10_000,
      model: asProviderModel({
        provider: "opencode-go",
        id: "deepseek-v4-flash",
        requestTimeoutMs: 2_000,
      }),
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(wasAborted()).toBe(true);
    await consumer;
  });

  it("aborts and releases the underlying stream when no first event arrives", async () => {
    const { consumer, received, getReturnCalls, capturedSignals, wasAborted } =
      await createStreamHarness({
        firstEventTimeoutMs: 10_000,
        model: asProviderModel({
          api: "openai-responses",
          provider: "opencode-go",
          id: "gpt-5.6-luna",
        }),
      });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(wasAborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(capturedSignals).toHaveLength(1);
    expect(wasAborted()).toBe(true);
    expect(getReturnCalls()).toBe(1);
    const error = received.find((event): event is ErrorEvent => event.type === "error");
    expect(error?.error).toMatchObject({
      api: "openai-responses",
      provider: "opencode-go",
      model: "gpt-5.6-luna",
    });

    await consumer;
  });

  it("preserves Anthropic model identity when a stream ends before its first event", async () => {
    const { controller, consumer, received } = await createStreamHarness({
      model: asProviderModel({
        api: "anthropic-messages",
        provider: "opencode-go",
        id: "qwen3.8-max",
      }),
    });
    controller.end();
    await consumer;

    const error = received.find((event): event is ErrorEvent => event.type === "error");
    expect(error?.error).toMatchObject({
      api: "anthropic-messages",
      provider: "opencode-go",
      model: "qwen3.8-max",
    });
  });

  it("aborts stream creation when the upstream stream promise never resolves", async () => {
    const { consumer, received, wasAborted } = await createStreamHarness({
      source: new Promise<StreamLike>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(wasAborted()).toBe(true);
    expect(received.some((event) => event.type === "error" && event.reason === "error")).toBe(true);
    await consumer;
  });

  it("preserves caller abort reasons in the wrapped provider signal", async () => {
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    const { controller, consumer, providerSignal } = await createStreamHarness({
      callOptions: { signal: caller.signal } as ProviderCallOptions,
    });
    caller.abort(reason);

    expect(providerSignal()?.aborted).toBe(true);
    expect(providerSignal()?.reason).toBe(reason);

    controller.end();
    await consumer;
  });

  it("keeps block-boundary streams alive and clears the timer after completion", async () => {
    // Regression #96518: block boundaries, not only token deltas, prove provider liveness.
    const { controller, consumer, received, wasAborted } = await createStreamHarness({
      idleTimeoutMs: 5_000,
      model: { provider: "opencode-go", id: "glm-4.6" } as ProviderModel,
    });
    const partial = { role: "assistant", content: [{ type: "text", text: "x" }] };

    controller.emit({ type: "start", partial } as AnyEvent);
    controller.emit({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{",
      partial,
    } as AnyEvent);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(3_000);
    controller.emit(
      asProviderEvent({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { name: "f", arguments: "{}" },
        partial,
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    controller.emit({
      type: "toolcall_start",
      contentIndex: 1,
      partial,
    } as AnyEvent);

    await vi.advanceTimersByTimeAsync(1_000);

    controller.emit({
      type: "done",
      reason: "stop",
      message: {
        ...partial,
        content: [{ type: "text", text: "final answer" }],
        stopReason: "stop",
      },
    } as AnyEvent);
    controller.end();
    await vi.advanceTimersByTimeAsync(10_000);
    await consumer;

    const hasDone = received.some((e) => e.type === "done");
    const hasStalledError = received.some(
      (e) => e.type === "error" && e.error?.stopReason === "error",
    );

    expect(wasAborted()).toBe(false);
    expect(hasDone).toBe(true);
    expect(hasStalledError).toBe(false);
  });
});
