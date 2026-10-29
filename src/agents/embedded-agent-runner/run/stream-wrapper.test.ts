import { createHook } from "node:async_hooks";
import type { AssistantMessageEvent } from "@openclaw/llm-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { PluginInstance } from "../../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

describe.each(["native", "plugin"] as const)("%s stream event transforms", (kind) => {
  function createStream(): MutableAssistantMessageEventStream {
    const message = makeAssistantMessageFixture();
    const stream: MutableAssistantMessageEventStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message };
      },
      result: async () => message,
    };
    if (kind === "native") {
      return stream;
    }
    const record = createPluginRecord({ id: "stream-transforms", origin: "workspace" });
    const registry = { ...createEmptyPluginRegistry(), plugins: [record] };
    const instance = new PluginInstance(record.id, { record, registry });
    const consumer = instance.retainConsumer();
    onTestFinished(async () => {
      consumer.release();
      await instance.dispose();
    });
    return consumer.wrap(stream);
  }
  it("bounds synchronous promise allocations for three adjacent transforms", async () => {
    const samples = [];
    for (const transformCount of [1, 3]) {
      const stream = createStream();
      const result = {
        done: false as const,
        value: { type: "text_delta" as const, contentIndex: 0, delta: "x" },
      };
      let sourceReads = 0;
      stream[Symbol.asyncIterator] = () => ({
        next: () => {
          sourceReads++;
          return Promise.resolve(result);
        },
      });
      const calls: number[] = [];
      const factories = new Set();
      for (let index = 0; index < transformCount; index++) {
        wrapStreamObjectEvents(stream, () => {
          calls.push(index);
        });
        factories.add(stream[Symbol.asyncIterator]);
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
      expect(calls).toEqual(
        Array.from({ length: 16 }, () =>
          Array.from({ length: transformCount }, (_, index) => index),
        ).flat(),
      );
      expect(sourceReads).toBe(16);
      samples.push({ transformCount, factories: factories.size, promises, sourceReads });
      await iterator.return?.();
    }
    // Synchronous allocations only: neither wall-clock benchmark nor all async descendants.
    console.info("stream-transform-counters", JSON.stringify({ kind, samples }));
    expect(samples.map((sample) => sample.factories)).toEqual([1, 1]);
    if (!process.versions.bun) {
      expect(samples[1]?.promises).toBe(samples[0]?.promises);
      expect(samples[0]?.promises).toBeGreaterThan(0);
    }
  });

  it("delivers native event content and identity with three adjacent transforms", async () => {
    const stream = createStream();
    const message = makeAssistantMessageFixture();
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: message },
      { type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
      { type: "done", reason: "stop", message },
    ];
    const sourceNext = vi.fn();
    stream[Symbol.asyncIterator] = async function* () {
      for (const event of events) {
        sourceNext();
        yield event;
      }
    };
    const calls: string[] = [];
    for (let index = 0; index < 3; index++) {
      expect(
        wrapStreamObjectEvents(stream, (event) => {
          calls.push(String(event.type) + ":" + index);
        }),
      ).toBe(stream);
    }
    const delivered: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      delivered.push(event);
    }
    expect(delivered).toEqual(events);
    expect(sourceNext).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([
      "start:0",
      "start:1",
      "start:2",
      "text_delta:0",
      "text_delta:1",
      "text_delta:2",
      "done:0",
      "done:1",
      "done:2",
    ]);
  });

  it("closes the original generator exactly once on an early consumer return", async () => {
    const stream = createStream();
    const closed = vi.fn();
    const sourceNext = vi.fn();
    const transform = vi.fn();
    stream[Symbol.asyncIterator] = async function* () {
      try {
        for (let index = 0; index < 3; index++) {
          sourceNext();
          yield { type: "start", partial: makeAssistantMessageFixture() };
        }
      } finally {
        closed();
      }
    };
    for (let index = 0; index < 3; index++) {
      wrapStreamObjectEvents(stream, transform);
    }
    for await (const event of stream) {
      expect(event.type).toBe("start");
      break;
    }
    expect(sourceNext).toHaveBeenCalledTimes(1);
    expect(transform).toHaveBeenCalledTimes(3);
    expect(closed).toHaveBeenCalledTimes(1);
  });

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

  it.runIf(kind === "plugin")(
    "keeps interleaved transforms in their admitting request",
    async () => {
      const streams = [new AbortController().signal, new AbortController().signal].map((signal) =>
        withPluginRuntimeGatewayRequestScope({ isWebchatConnect: () => false, signal }, () => {
          const stream = createStream();
          for (let index = 0; index < 3; index++) {
            wrapStreamObjectEvents(stream, async () => {
              const scope = getPluginRuntimeGatewayRequestScope();
              expect(scope?.pluginId).toBe("stream-transforms");
              expect(scope?.signal).toBe(signal);
              await Promise.resolve();
              expect(getPluginRuntimeGatewayRequestScope()).toBe(scope);
            });
          }
          return stream[Symbol.asyncIterator]();
        }),
      );
      await Promise.all(streams.map((stream) => stream.next()));
      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
      for (const stream of streams) {
        await stream.return?.();
      }
    },
  );

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
    // Preserve B's native same-iterator return/throw contract; managed iterator
    // calls are retired after return, so open another admitted iterator there.
    const throwingIterator = kind === "native" ? iterator : stream[Symbol.asyncIterator]();
    await throwingIterator.throw?.(error);
    expect(onReturn).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(onThrow).toHaveBeenCalledExactlyOnceWith(error);
  });
});
