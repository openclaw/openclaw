import {
  notifyLlmRequestActivity,
  type FirstStreamEventInternalOptions,
} from "@openclaw/ai/internal/runtime";
import { notifyProviderStreamOpened } from "@openclaw/ai/transports";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

function createNeverYieldingStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
  };
}

// Creation ends at provider acceptance or stream activity, not when a producer
// returns its stream object.
describe("streamWithIdleTimeout request deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creation-only scope bounds stream creation but not iterator gaps", async () => {
    vi.useFakeTimers();
    // Creation hang: still rejected at the deadline.
    const hangingCreate = vi.fn(
      () => new Promise<AssistantMessageEventStream>(() => {}),
    ) as unknown as Parameters<typeof streamWithIdleTimeout>[0];
    const onIdleTimeout = vi.fn();
    const wrappedCreate = streamWithIdleTimeout(hangingCreate, 50, onIdleTimeout, {
      scope: "creation-only",
    });
    const model = {} as Parameters<typeof hangingCreate>[0];
    const context = {} as Parameters<typeof hangingCreate>[1];
    const options = {} as Parameters<typeof hangingCreate>[2];
    const pending = expect(wrappedCreate(model, context, options)).rejects.toThrow(
      /LLM idle timeout/,
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);

    // Iterator gap after provider acceptance: never bounded — local providers
    // own their stream pacing.
    const slowStream = createNeverYieldingStream();
    const slowFn = vi.fn(
      (_model: unknown, _context: unknown, streamOptions?: { signal?: AbortSignal }) => {
        notifyLlmRequestActivity(streamOptions?.signal);
        return slowStream;
      },
    ) as unknown as Parameters<typeof streamWithIdleTimeout>[0];
    const wrappedGaps = streamWithIdleTimeout(slowFn, 50, onIdleTimeout, {
      scope: "creation-only",
    });
    const stream = wrappedGaps(
      model as Parameters<typeof slowFn>[0],
      context as Parameters<typeof slowFn>[1],
      options as Parameters<typeof slowFn>[2],
    ) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();
    let settled = false;
    void iterator.next().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
  });

  it.each(["acceptance", "activity"] as const)(
    "guards a pending cloud factory after provider %s without policing local gaps",
    async (event) => {
      vi.useFakeTimers();
      for (const scope of ["creation-and-gaps", "creation-only"] as const) {
        const caller = new AbortController();
        const created = createDeferred<AssistantMessageEventStream>();
        const source = createAssistantMessageEventStream();
        const onIdleTimeout = vi.fn();
        let requestSignal: AbortSignal | undefined;
        let accept: () => void | Promise<void> = () => {};
        const baseFn: StreamFn = (_model, _context, options) => {
          requestSignal = options?.signal;
          accept = () =>
            event === "activity"
              ? notifyLlmRequestActivity(requestSignal)
              : notifyProviderStreamOpened({ options, cancelStream: () => {} });
          return created.promise;
        };
        const options: NonNullable<Parameters<StreamFn>[2]> & FirstStreamEventInternalOptions = {
          signal: caller.signal,
          firstEventTimeoutMs: 200,
        };
        const opening = Promise.resolve(
          streamWithIdleTimeout(baseFn, 50, onIdleTimeout, { scope })(
            {} as Parameters<StreamFn>[0],
            { messages: [] },
            options,
          ),
        ).catch((error: unknown) => error);
        try {
          await vi.advanceTimersByTimeAsync(20);
          await accept();
          await vi.advanceTimersByTimeAsync(49);
          expect(onIdleTimeout).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          if (scope === "creation-and-gaps") {
            expect(onIdleTimeout).toHaveBeenCalledOnce();
            expect(await opening).toBe(onIdleTimeout.mock.calls[0]?.[0]);
            expect(requestSignal?.aborted).toBe(true);
          } else {
            await vi.advanceTimersByTimeAsync(500);
            expect(onIdleTimeout).not.toHaveBeenCalled();
            expect(requestSignal?.aborted).toBe(false);
            created.resolve(source);
            expect(await opening).toBe(source);
          }
        } finally {
          caller.abort();
          source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
          created.resolve(source);
          await opening;
        }
      }
    },
  );

  it.each([false, true])(
    "keeps the accepted deadline until the iterator watchdog takes over (consume: %s)",
    async (consume) => {
      vi.useFakeTimers();
      const created = createDeferred<AssistantMessageEventStream>();
      const source = createAssistantMessageEventStream();
      const onIdleTimeout = vi.fn();
      const baseFn: StreamFn = (_model, _context, options) => {
        notifyLlmRequestActivity(options?.signal);
        return created.promise;
      };
      const opening = streamWithIdleTimeout(
        baseFn,
        50,
        onIdleTimeout,
      )({} as Parameters<StreamFn>[0], { messages: [] });
      await vi.advanceTimersByTimeAsync(20);
      created.resolve(source);
      const stream = await opening;
      const iterator = stream[Symbol.asyncIterator]();
      try {
        await vi.advanceTimersByTimeAsync(29);
        expect(onIdleTimeout).not.toHaveBeenCalled();
        const next = consume ? iterator.next().catch((error: unknown) => error) : undefined;
        if (consume) {
          await vi.advanceTimersByTimeAsync(49);
          expect(onIdleTimeout).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(onIdleTimeout).toHaveBeenCalledOnce();
        const outcome = next ?? iterator.next().catch((error: unknown) => error);
        expect(await outcome).toBe(onIdleTimeout.mock.calls[0]?.[0]);
      } finally {
        source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
        await iterator.return?.();
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(onIdleTimeout).toHaveBeenCalledOnce();
    },
  );

  it("keeps one local creation deadline when an async producer returns before headers", async () => {
    vi.useFakeTimers();
    const created = createDeferred<AssistantMessageEventStream>();
    const source = createAssistantMessageEventStream();
    const onIdleTimeout = vi.fn();
    const baseFn: StreamFn = () => created.promise;
    const opening = streamWithIdleTimeout(baseFn, 50, onIdleTimeout, { scope: "creation-only" })(
      {} as Parameters<StreamFn>[0],
      { messages: [] },
    );
    await vi.advanceTimersByTimeAsync(40);
    created.resolve(source);
    const stream = await opening;
    const next = stream[Symbol.asyncIterator]()
      .next()
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(9);
      expect(onIdleTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onIdleTimeout).toHaveBeenCalledOnce();
      expect(await next).toBe(onIdleTimeout.mock.calls[0]?.[0]);
    } finally {
      source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
      await next;
    }
  });
});
