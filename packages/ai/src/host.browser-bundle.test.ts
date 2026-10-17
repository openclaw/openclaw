import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";

type BrowserHostModule = {
  configureAiTransportHost(host: object): void;
  createAssistantMessageEventStream(): {
    push(event: object): void;
    result(): Promise<unknown>;
  };
  createApiRegistry(): {
    registerApiProvider(provider: object): void;
  };
  createLlmRuntime(registry: object): {
    stream(
      model: object,
      context: object,
    ): {
      result(): Promise<unknown>;
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
    };
  };
  getDefaultAiTransportHost(): unknown;
  getAiTransportHost(): { resolveSecretSentinel(value: string): string };
  runWithAiTransportHost<T>(host: unknown, run: () => T): T;
};

it("keeps the default transport host usable in browser bundles", async () => {
  const result = await build({
    stdin: {
      contents:
        'export * from "./index.ts"; export { createAssistantMessageEventStream } from "@openclaw/llm-core/event-stream";',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "browser-host-entry.ts",
    },
    bundle: true,
    format: "iife",
    globalName: "OpenClawAiHost",
    logLevel: "silent",
    platform: "browser",
    write: false,
  });

  expect(result.errors).toEqual([]);
  const context: {
    OpenClawAiHost?: BrowserHostModule;
    TextDecoder: typeof TextDecoder;
    TextEncoder: typeof TextEncoder;
  } = {
    TextDecoder,
    TextEncoder,
  };
  runInNewContext(result.outputFiles[0]?.text ?? "", context);
  const browserHost = context.OpenClawAiHost;
  if (!browserHost) {
    throw new Error("browser bundle did not expose its host contract");
  }
  const start = (source: object, id: string) => {
    const registry = browserHost.createApiRegistry();
    // Providers belong to this test realm, not the browser VM realm.
    registry.registerApiProvider({ api: id, stream: () => source, streamSimple: () => source });
    return browserHost
      .createLlmRuntime(registry)
      .stream({ api: id, provider: "fixture", id }, { messages: [] });
  };
  const expectPending = () =>
    expect(() => browserHost.configureAiTransportHost({})).toThrow(
      "Cannot replace the AI transport host while browser provider work is pending",
    );
  async function collect(stream: AsyncIterable<unknown>) {
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  }
  expect(
    browserHost.runWithAiTransportHost(browserHost.getDefaultAiTransportHost(), () => "ok"),
  ).toBe("ok");

  const final = { role: "assistant", content: [], stopReason: "stop" };
  const done = { type: "done", reason: "stop", message: final };
  const started = { type: "start", partial: final };
  const source = {
    push() {},
    end() {},
    async result() {
      return final;
    },
    async *[Symbol.asyncIterator]() {},
  };
  const stream = start(source, "browser-test");
  expectPending();
  await expect(stream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const resultGate = Promise.withResolvers<void>();
  const pendingSource = {
    ...source,
    async result() {
      await resultGate.promise;
      return final;
    },
  };
  const pendingStream = start(pendingSource, "browser-pending-test");
  expect(await pendingStream[Symbol.asyncIterator]().next()).toEqual({
    done: true,
    value: undefined,
  });
  expectPending();
  resultGate.resolve();
  await expect(pendingStream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const nativeSource = browserHost.createAssistantMessageEventStream();
  const nativeStream = start(nativeSource, "browser-native-test");
  const delegatedSource = browserHost.createAssistantMessageEventStream();
  const delegatedNativeStream = start(delegatedSource, "browser-delegated-native-test");
  const delegatedStream = start(delegatedNativeStream, "browser-delegated-test");
  expectPending();
  nativeSource.push({ type: "done", reason: "stop", message: final });
  delegatedSource.push({ type: "done", reason: "stop", message: final });
  await Promise.all([nativeSource.result(), delegatedSource.result()]);
  await Promise.resolve();
  browserHost.configureAiTransportHost({});
  await expect(nativeStream.result()).resolves.toBe(final);
  await expect(delegatedStream.result()).resolves.toBe(final);
  expect(await collect(nativeStream)).toEqual([done]);
  expect(await collect(delegatedStream)).toEqual([done]);

  browserHost.configureAiTransportHost({
    resolveSecretSentinel: () => "custom-old",
  });
  const customIteratorHosts: string[] = [];
  const customResult = Promise.withResolvers<typeof final>();
  const customSource = {
    ...source,
    result: async () => customResult.promise,
    async *[Symbol.asyncIterator]() {
      customIteratorHosts.push(
        browserHost.getAiTransportHost().resolveSecretSentinel("custom-iterator"),
      );
      yield { type: "done", reason: "stop", message: final };
      customResult.resolve(final);
    },
  };
  const customStream = start(customSource, "browser-custom-test");
  await expect(customStream.result()).resolves.toBe(final);
  expect(customIteratorHosts).toEqual(["custom-old"]);
  browserHost.configureAiTransportHost({
    resolveSecretSentinel: () => "custom-new",
  });
  expect(await collect(customStream)).toEqual([done]);
  expect(await collect(customStream)).toEqual([done]);
  expect(customIteratorHosts).toEqual(["custom-old"]);

  const liveDrainGate = Promise.withResolvers<void>();
  const liveResultGate = Promise.withResolvers<void>();
  const liveSource = {
    ...source,
    async result() {
      await liveResultGate.promise;
      return final;
    },
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: final };
      await liveDrainGate.promise;
      yield { type: "done", reason: "stop", message: final };
    },
  };
  const liveStream = start(liveSource, "browser-live-custom-test");
  const liveResult = liveStream.result();
  liveResultGate.resolve();
  const liveIterator = liveStream[Symbol.asyncIterator]();
  await expect(liveIterator.next()).resolves.toEqual({
    done: false,
    value: started,
  });
  const cancelledLiveIterator = liveStream[Symbol.asyncIterator]();
  await expect(cancelledLiveIterator.next()).resolves.toEqual({
    done: false,
    value: started,
  });
  const cancelledLiveRead = cancelledLiveIterator.next();
  await cancelledLiveIterator.return?.();
  await expect(cancelledLiveRead).resolves.toEqual({ done: true, value: undefined });
  expectPending();
  liveDrainGate.resolve();
  await expect(liveIterator.next()).resolves.toEqual({
    done: false,
    value: done,
  });
  await expect(liveIterator.next()).resolves.toEqual({ done: true, value: undefined });
  await expect(liveResult).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const sharedIteratorGate = Promise.withResolvers<void>();
  const sharedIterator = (async function* () {
    yield { type: "start" as const, partial: final };
    await sharedIteratorGate.promise;
    yield { type: "done" as const, reason: "stop" as const, message: final };
  })();
  let sharedIteratorCalls = 0;
  const sharedSource = {
    ...source,
    [Symbol.asyncIterator]() {
      sharedIteratorCalls += 1;
      return sharedIterator;
    },
  };
  const sharedStream = start(sharedSource, "browser-shared-custom-test");
  const liveSharedIterator = sharedStream[Symbol.asyncIterator]();
  const sharedResult = sharedStream.result();
  expect(sharedIteratorCalls).toBe(1);
  await expect(liveSharedIterator.next()).resolves.toEqual({
    done: false,
    value: started,
  });
  await expect(sharedResult).resolves.toBe(final);
  expectPending();
  sharedIteratorGate.resolve();
  await expect(liveSharedIterator.next()).resolves.toEqual({
    done: false,
    value: done,
  });
  await expect(liveSharedIterator.next()).resolves.toEqual({ done: true, value: undefined });
  expect(sharedIteratorCalls).toBe(1);
  browserHost.configureAiTransportHost({});
  expect(await collect(sharedStream)).toEqual([started, done]);

  const failedResultGate = Promise.withResolvers<void>();
  const iteratorError = new Error("custom iterator failed");
  const failedSource = {
    ...source,
    async result() {
      await failedResultGate.promise;
      return final;
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      throw iteratorError;
    },
  };
  const failedStream = start(failedSource, "browser-failed-custom-test");
  await expect(failedStream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    message: "Stream iteration failed",
    cause: iteratorError,
  });
  const failedResult = failedStream.result();
  expectPending();
  failedResultGate.resolve();
  await expect(failedResult).resolves.toBe(final);
  browserHost.configureAiTransportHost({});
});
