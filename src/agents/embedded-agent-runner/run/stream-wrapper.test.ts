import { createHook } from "node:async_hooks";
import type { AssistantMessageEvent } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

function createStream(): MutableAssistantMessageEventStream {
  const message = makeAssistantMessageFixture();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
    },
    result: async () => message,
  };
}

describe("stream event transforms", () => {
  it.runIf(!process.versions.bun)(
    "adds one promise per read for adjacent synchronous transforms",
    async () => {
      const stream = createStream();
      const result = {
        done: false as const,
        value: { type: "text_delta" as const, contentIndex: 0, delta: "x" },
      };
      stream[Symbol.asyncIterator] = () => ({ next: () => Promise.resolve(result) });
      const calls: number[] = [];
      for (let index = 0; index < 3; index++) {
        wrapStreamObjectEvents(stream, () => {
          calls.push(index);
        });
      }
      const iterator = stream[Symbol.asyncIterator]();
      let promises = 0;
      const hook = createHook({
        init(_id, type) {
          if (type === "PROMISE") {
            promises++;
          }
        },
      });
      for (let index = 0; index < 16; index++) {
        let pending: ReturnType<typeof iterator.next>;
        hook.enable();
        try {
          pending = iterator.next();
        } finally {
          hook.disable();
        }
        expect(await pending).toBe(result);
      }
      expect(calls).toEqual(Array.from({ length: 16 }, () => [0, 1, 2]).flat());
      // One source promise and one shared transform continuation per read.
      expect(promises).toBe(32);
    },
  );

  it("awaits asynchronous transforms in registration order before exposing the event", async () => {
    const stream = createStream();
    const entered = createDeferred();
    const release = createDeferred();
    const calls: string[] = [];
    wrapStreamObjectEvents(stream, () => {
      calls.push("first");
    });
    wrapStreamObjectEvents(stream, async () => {
      entered.resolve();
      await release.promise;
      calls.push("second");
    });
    wrapStreamObjectEvents(stream, () => {
      calls.push("third");
    });
    const next = stream[Symbol.asyncIterator]().next();
    await entered.promise;
    expect(calls).toEqual(["first"]);
    release.resolve();
    expect(await next).toMatchObject({ done: false, value: { type: "start" } });
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("preserves an intervening iterator that replaces events", async () => {
    const stream = createStream();
    const calls: string[] = [];
    wrapStreamObjectEvents(stream, () => {
      calls.push("inner");
    });
    const original = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: original }) {
        calls.push("replace");
        yield { ...event, replacement: true };
      }
    };
    wrapStreamObjectEvents(stream, (event) => {
      expect(event.replacement).toBe(true);
      calls.push("outer");
    });
    await stream[Symbol.asyncIterator]().next();
    expect(calls).toEqual(["inner", "replace", "outer"]);
  });

  it.each(["source-throw", "source-reject", "transform-throw", "transform-reject"])(
    "rejects %s without delivering an event or running later transforms",
    async (mode) => {
      const stream = createStream();
      const failure = new Error("stream failed");
      if (mode.startsWith("source")) {
        stream[Symbol.asyncIterator] = () => ({
          next: () => {
            if (mode === "source-throw") {
              throw failure;
            }
            return Promise.reject(failure);
          },
        });
      }
      wrapStreamObjectEvents(stream, () => {
        if (mode === "transform-throw") {
          throw failure;
        }
        return Promise.reject(failure);
      });
      const later = vi.fn();
      wrapStreamObjectEvents(stream, later);
      const pending = stream[Symbol.asyncIterator]().next();
      await expect(pending).rejects.toBe(failure);
      expect(later).not.toHaveBeenCalled();
    },
  );

  it("keeps transforms added later out of an already opened iterator", async () => {
    const stream = createStream();
    const first = vi.fn();
    const later = vi.fn();
    wrapStreamObjectEvents(stream, first);
    const opened = stream[Symbol.asyncIterator]();
    wrapStreamObjectEvents(stream, later);
    await opened.next();
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    await stream[Symbol.asyncIterator]().next();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("forwards consumer cancellation and errors to the original iterator", async () => {
    const stream = createStream();
    const onReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const onThrow = vi.fn(async () => ({ done: true as const, value: undefined }));
    stream[Symbol.asyncIterator] = (): AsyncIterator<AssistantMessageEvent> => ({
      next: async () => ({ done: true, value: undefined }),
      return: onReturn,
      throw: onThrow,
    });
    wrapStreamObjectEvents(stream, vi.fn());
    wrapStreamObjectEvents(stream, vi.fn());
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.return?.("cancelled");
    const error = new Error("consumer failed");
    await iterator.throw?.(error);
    expect(onReturn).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(onThrow).toHaveBeenCalledExactlyOnceWith(error);
  });
});
