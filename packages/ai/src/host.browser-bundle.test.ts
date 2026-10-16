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
  expect(
    browserHost.runWithAiTransportHost(browserHost.getDefaultAiTransportHost(), () => "ok"),
  ).toBe("ok");

  const final = { role: "assistant", content: [], stopReason: "stop" };
  const source = {
    push() {},
    end() {},
    async result() {
      return final;
    },
    async *[Symbol.asyncIterator]() {},
  };
  const registry = browserHost.createApiRegistry();
  registry.registerApiProvider({
    api: "browser-test",
    // The provider belongs to this test realm, not the browser VM realm.
    stream: () => source,
    streamSimple: () => source,
  });
  const runtime = browserHost.createLlmRuntime(registry);
  const stream = runtime.stream(
    { api: "browser-test", provider: "fixture", id: "browser" },
    { messages: [] },
  );
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  await expect(stream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  let releaseResult!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const pendingSource = {
    ...source,
    async result() {
      await resultGate;
      return final;
    },
  };
  const pendingRegistry = browserHost.createApiRegistry();
  pendingRegistry.registerApiProvider({
    api: "browser-pending-test",
    stream: () => pendingSource,
    streamSimple: () => pendingSource,
  });
  const pendingStream = browserHost
    .createLlmRuntime(pendingRegistry)
    .stream(
      { api: "browser-pending-test", provider: "fixture", id: "browser-pending" },
      { messages: [] },
    );
  expect(await pendingStream[Symbol.asyncIterator]().next()).toEqual({
    done: true,
    value: undefined,
  });
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  releaseResult();
  await expect(pendingStream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const nativeSource = browserHost.createAssistantMessageEventStream();
  const nativeRegistry = browserHost.createApiRegistry();
  nativeRegistry.registerApiProvider({
    api: "browser-native-test",
    stream: () => nativeSource,
    streamSimple: () => nativeSource,
  });
  const nativeStream = browserHost
    .createLlmRuntime(nativeRegistry)
    .stream(
      { api: "browser-native-test", provider: "fixture", id: "browser-native" },
      { messages: [] },
    );
  const delegatedSource = browserHost.createAssistantMessageEventStream();
  const delegatedNativeRegistry = browserHost.createApiRegistry();
  delegatedNativeRegistry.registerApiProvider({
    api: "browser-delegated-native-test",
    stream: () => delegatedSource,
    streamSimple: () => delegatedSource,
  });
  const delegatedNativeStream = browserHost.createLlmRuntime(delegatedNativeRegistry).stream(
    {
      api: "browser-delegated-native-test",
      provider: "fixture",
      id: "browser-delegated-native",
    },
    { messages: [] },
  );
  const delegatedRegistry = browserHost.createApiRegistry();
  delegatedRegistry.registerApiProvider({
    api: "browser-delegated-test",
    stream: () => delegatedNativeStream,
    streamSimple: () => delegatedNativeStream,
  });
  const delegatedStream = browserHost
    .createLlmRuntime(delegatedRegistry)
    .stream(
      { api: "browser-delegated-test", provider: "fixture", id: "browser-delegated" },
      { messages: [] },
    );
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  nativeSource.push({ type: "done", reason: "stop", message: final });
  delegatedSource.push({ type: "done", reason: "stop", message: final });
  await Promise.all([nativeSource.result(), delegatedSource.result()]);
  await Promise.resolve();
  browserHost.configureAiTransportHost({});
  await expect(nativeStream.result()).resolves.toBe(final);
  await expect(delegatedStream.result()).resolves.toBe(final);
  const nativeEvents = [];
  for await (const event of nativeStream) {
    nativeEvents.push(event);
  }
  expect(nativeEvents).toEqual([{ type: "done", reason: "stop", message: final }]);
  const delegatedEvents = [];
  for await (const event of delegatedStream) {
    delegatedEvents.push(event);
  }
  expect(delegatedEvents).toEqual([{ type: "done", reason: "stop", message: final }]);

  browserHost.configureAiTransportHost({
    resolveSecretSentinel: () => "custom-old",
  });
  const customIteratorHosts: string[] = [];
  let resolveCustomResult!: (message: typeof final) => void;
  const customResult = new Promise<typeof final>((resolve) => {
    resolveCustomResult = resolve;
  });
  const customSource = {
    push() {},
    end() {},
    async result() {
      return customResult;
    },
    async *[Symbol.asyncIterator]() {
      customIteratorHosts.push(
        browserHost.getAiTransportHost().resolveSecretSentinel("custom-iterator"),
      );
      yield { type: "done", reason: "stop", message: final };
      resolveCustomResult(final);
    },
  };
  const customRegistry = browserHost.createApiRegistry();
  customRegistry.registerApiProvider({
    api: "browser-custom-test",
    stream: () => customSource,
    streamSimple: () => customSource,
  });
  const customStream = browserHost
    .createLlmRuntime(customRegistry)
    .stream(
      { api: "browser-custom-test", provider: "fixture", id: "browser-custom" },
      { messages: [] },
    );
  await expect(customStream.result()).resolves.toBe(final);
  expect(customIteratorHosts).toEqual(["custom-old"]);
  browserHost.configureAiTransportHost({
    resolveSecretSentinel: () => "custom-new",
  });
  const customEvents = [];
  for await (const event of customStream) {
    customEvents.push(event);
  }
  expect(customEvents).toEqual([{ type: "done", reason: "stop", message: final }]);
  const replayedCustomEvents = [];
  for await (const event of customStream) {
    replayedCustomEvents.push(event);
  }
  expect(replayedCustomEvents).toEqual([{ type: "done", reason: "stop", message: final }]);
  expect(customIteratorHosts).toEqual(["custom-old"]);

  let releaseLiveDrain!: () => void;
  const liveDrainGate = new Promise<void>((resolve) => {
    releaseLiveDrain = resolve;
  });
  let releaseLiveResult!: () => void;
  const liveResultGate = new Promise<void>((resolve) => {
    releaseLiveResult = resolve;
  });
  const liveSource = {
    push() {},
    end() {},
    async result() {
      await liveResultGate;
      return final;
    },
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: final };
      await liveDrainGate;
      yield { type: "done", reason: "stop", message: final };
    },
  };
  const liveRegistry = browserHost.createApiRegistry();
  liveRegistry.registerApiProvider({
    api: "browser-live-custom-test",
    stream: () => liveSource,
    streamSimple: () => liveSource,
  });
  const liveStream = browserHost
    .createLlmRuntime(liveRegistry)
    .stream(
      { api: "browser-live-custom-test", provider: "fixture", id: "browser-live-custom" },
      { messages: [] },
    );
  const liveResult = liveStream.result();
  releaseLiveResult();
  const liveIterator = liveStream[Symbol.asyncIterator]();
  await expect(liveIterator.next()).resolves.toEqual({
    done: false,
    value: { type: "start", partial: final },
  });
  const cancelledLiveIterator = liveStream[Symbol.asyncIterator]();
  await expect(cancelledLiveIterator.next()).resolves.toEqual({
    done: false,
    value: { type: "start", partial: final },
  });
  const cancelledLiveRead = cancelledLiveIterator.next();
  await cancelledLiveIterator.return?.();
  await expect(cancelledLiveRead).resolves.toEqual({ done: true, value: undefined });
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  releaseLiveDrain();
  await expect(liveIterator.next()).resolves.toEqual({
    done: false,
    value: { type: "done", reason: "stop", message: final },
  });
  await expect(liveIterator.next()).resolves.toEqual({ done: true, value: undefined });
  await expect(liveResult).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  let releaseSharedIterator!: () => void;
  const sharedIteratorGate = new Promise<void>((resolve) => {
    releaseSharedIterator = resolve;
  });
  const sharedIterator = (async function* () {
    yield { type: "start" as const, partial: final };
    await sharedIteratorGate;
    yield { type: "done" as const, reason: "stop" as const, message: final };
  })();
  let sharedIteratorCalls = 0;
  const sharedSource = {
    push() {},
    end() {},
    async result() {
      return final;
    },
    [Symbol.asyncIterator]() {
      sharedIteratorCalls += 1;
      return sharedIterator;
    },
  };
  const sharedRegistry = browserHost.createApiRegistry();
  sharedRegistry.registerApiProvider({
    api: "browser-shared-custom-test",
    stream: () => sharedSource,
    streamSimple: () => sharedSource,
  });
  const sharedStream = browserHost
    .createLlmRuntime(sharedRegistry)
    .stream(
      { api: "browser-shared-custom-test", provider: "fixture", id: "browser-shared-custom" },
      { messages: [] },
    );
  const liveSharedIterator = sharedStream[Symbol.asyncIterator]();
  const sharedResult = sharedStream.result();
  expect(sharedIteratorCalls).toBe(1);
  await expect(liveSharedIterator.next()).resolves.toEqual({
    done: false,
    value: { type: "start", partial: final },
  });
  await expect(sharedResult).resolves.toBe(final);
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  releaseSharedIterator();
  await expect(liveSharedIterator.next()).resolves.toEqual({
    done: false,
    value: { type: "done", reason: "stop", message: final },
  });
  await expect(liveSharedIterator.next()).resolves.toEqual({ done: true, value: undefined });
  expect(sharedIteratorCalls).toBe(1);
  browserHost.configureAiTransportHost({});
  const replayedSharedEvents = [];
  for await (const event of sharedStream) {
    replayedSharedEvents.push(event);
  }
  expect(replayedSharedEvents).toEqual([
    { type: "start", partial: final },
    { type: "done", reason: "stop", message: final },
  ]);

  let releaseFailedResult!: () => void;
  const failedResultGate = new Promise<void>((resolve) => {
    releaseFailedResult = resolve;
  });
  const iteratorError = new Error("custom iterator failed");
  const failedSource = {
    push() {},
    end() {},
    async result() {
      await failedResultGate;
      return final;
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      throw iteratorError;
    },
  };
  const failedRegistry = browserHost.createApiRegistry();
  failedRegistry.registerApiProvider({
    api: "browser-failed-custom-test",
    stream: () => failedSource,
    streamSimple: () => failedSource,
  });
  const failedStream = browserHost
    .createLlmRuntime(failedRegistry)
    .stream(
      { api: "browser-failed-custom-test", provider: "fixture", id: "browser-failed-custom" },
      { messages: [] },
    );
  await expect(failedStream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    message: "Stream iteration failed",
    cause: iteratorError,
  });
  const failedResult = failedStream.result();
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  releaseFailedResult();
  await expect(failedResult).resolves.toBe(final);
  browserHost.configureAiTransportHost({});
});
