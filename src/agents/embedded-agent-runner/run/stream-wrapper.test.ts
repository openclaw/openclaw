import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessageEvent } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { PluginInstance } from "../../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { wrapStreamObjectEvents, wrapStreamObjectSettlement } from "./stream-wrapper.js";

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
  it("retains the consumer's repair authority and registry while the instance is quiesced", async () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "retained-repair" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const retainedRegistry = createEmptyPluginRegistry();
    const consumer = instance.retainConsumer(undefined, retainedRegistry);
    const stream = consumer.wrap(createStream());
    const repair = instance.wrap(() => {
      expect(instance.hasActiveCall).toBe(true);
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(retainedRegistry);
    });
    wrapStreamObjectEvents(stream, repair);
    const iterator = stream[Symbol.asyncIterator]();
    try {
      instance.quiesce();
      expect(await iterator.next()).toMatchObject({ done: false, value: { type: "start" } });
      await iterator.return?.();
    } finally {
      consumer.release();
      await instance.dispose();
    }
  });

  it("coalesces owned stream transforms without reentering plugin scope for host decorators", async () => {
    const instance = new PluginInstance("stream-decorators");
    const consumer = instance.retainConsumer();
    const stream = consumer.wrap(createStream());
    const calls: string[] = [];
    wrapStreamObjectEvents(stream, () => {
      calls.push("first");
    });
    const projected = stream[Symbol.asyncIterator];
    wrapStreamObjectEvents(stream, () => {
      calls.push("second");
    });
    expect(stream[Symbol.asyncIterator]).toBe(projected);
    wrapStreamObjectSettlement(stream, async () => {
      calls.push("settled");
    });
    const iterator = stream[Symbol.asyncIterator]();
    const frames = vi.spyOn(AsyncLocalStorage.prototype, "run");
    try {
      expect(await iterator.next()).toMatchObject({ done: false, value: { type: "start" } });
      expect(calls).toEqual(["first", "second", "settled"]);
      expect(frames).toHaveBeenCalledTimes(2);
      consumer.release();
      await expect(iterator.next()).rejects.toThrow("stream is closed");
    } finally {
      frames.mockRestore();
      consumer.release();
      await instance.dispose();
    }
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
