import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "@openclaw/llm-core";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { collect } from "../../../test/helpers/async-iterable.js";
import { anthropicModel, assistantMessage } from "./provider-transport-parity.test-support.js";

type BrowserHostModule = typeof import("./index.js") &
  Pick<typeof import("@openclaw/llm-core/event-stream"), "createAssistantMessageEventStream">;

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

  const context: { OpenClawAiHost?: BrowserHostModule } & Record<string, unknown> = {
    TextDecoder,
    TextEncoder,
  };
  runInNewContext(result.outputFiles[0]?.text ?? "", context);
  const browserHost = context.OpenClawAiHost;
  if (!browserHost) {
    throw new Error("browser bundle did not expose its host contract");
  }
  const start = (source: AssistantMessageEventStreamContract, id: string) => {
    const registry = browserHost.createApiRegistry();
    // Providers belong to this test realm, not the browser VM realm.
    registry.registerApiProvider({ api: id, stream: () => source, streamSimple: () => source });
    return browserHost
      .createLlmRuntime(registry)
      .stream({ ...anthropicModel, api: id, provider: "fixture", id }, { messages: [] });
  };
  const expectPending = () =>
    expect(() => browserHost.configureAiTransportHost({})).toThrow(
      "Cannot replace the AI transport host while browser provider work is pending",
    );
  expect(
    browserHost.runWithAiTransportHost(browserHost.getDefaultAiTransportHost(), () => "ok"),
  ).toBe("ok");

  const final = assistantMessage(anthropicModel, []);
  const done: AssistantMessageEvent = { type: "done", reason: "stop", message: final };
  const started: AssistantMessageEvent = { type: "start", partial: final };
  const expectRead = (iterator: AsyncIterator<unknown>, value?: unknown) =>
    expect(iterator.next()).resolves.toEqual({ done: value === undefined, value });
  const source = {
    push() {},
    end() {},
    result: async () => final,
    async *[Symbol.asyncIterator]() {},
  };
  const waitingSource = (gate: Promise<void>) => ({
    ...source,
    async result() {
      await gate;
      return final;
    },
  });
  const stream = start(source, "browser-test");
  expectPending();
  await expect(stream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const resultGate = Promise.withResolvers<void>();
  const pendingStream = start(waitingSource(resultGate.promise), "browser-pending-test");
  await expectRead(pendingStream[Symbol.asyncIterator]());
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
  nativeSource.push(done);
  delegatedSource.push(done);
  await Promise.all([nativeSource.result(), delegatedSource.result()]);
  await Promise.resolve();
  browserHost.configureAiTransportHost({});
  await expect(nativeStream.result()).resolves.toBe(final);
  await expect(delegatedStream.result()).resolves.toBe(final);
  expect(await collect(nativeStream)).toEqual([done]);
  expect(await collect(delegatedStream)).toEqual([done]);

  browserHost.configureAiTransportHost({ resolveSecretSentinel: () => "custom-old" });
  const customIteratorHosts: string[] = [];
  const customResult = Promise.withResolvers<typeof final>();
  const customSource = {
    ...source,
    result: async () => customResult.promise,
    async *[Symbol.asyncIterator]() {
      customIteratorHosts.push(
        browserHost.getAiTransportHost().resolveSecretSentinel("custom-iterator"),
      );
      yield done;
      customResult.resolve(final);
    },
  };
  const customStream = start(customSource, "browser-custom-test");
  await expect(customStream.result()).resolves.toBe(final);
  expect(customIteratorHosts).toEqual(["custom-old"]);
  browserHost.configureAiTransportHost({ resolveSecretSentinel: () => "custom-new" });
  expect(await collect(customStream)).toEqual([done]);
  expect(await collect(customStream)).toEqual([done]);
  expect(customIteratorHosts).toEqual(["custom-old"]);

  const liveDrainGate = Promise.withResolvers<void>();
  const liveResultGate = Promise.withResolvers<void>();
  async function* drainingEvents(gate: Promise<void>) {
    yield started;
    await gate;
    yield done;
  }
  const liveSource = {
    ...waitingSource(liveResultGate.promise),
    [Symbol.asyncIterator]: () => drainingEvents(liveDrainGate.promise),
  };
  const liveStream = start(liveSource, "browser-live-custom-test");
  const liveResult = liveStream.result();
  liveResultGate.resolve();
  const liveIterator = liveStream[Symbol.asyncIterator]();
  await expectRead(liveIterator, started);
  const cancelledLiveIterator = liveStream[Symbol.asyncIterator]();
  await expectRead(cancelledLiveIterator, started);
  const cancelledLiveRead = cancelledLiveIterator.next();
  await cancelledLiveIterator.return?.();
  await expect(cancelledLiveRead).resolves.toEqual({ done: true, value: undefined });
  expectPending();
  liveDrainGate.resolve();
  await expectRead(liveIterator, done);
  await expectRead(liveIterator);
  await expect(liveResult).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const sharedIteratorGate = Promise.withResolvers<void>();
  const sharedIterator = drainingEvents(sharedIteratorGate.promise);
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
  await expectRead(liveSharedIterator, started);
  await expect(sharedResult).resolves.toBe(final);
  expectPending();
  sharedIteratorGate.resolve();
  await expectRead(liveSharedIterator, done);
  await expectRead(liveSharedIterator);
  expect(sharedIteratorCalls).toBe(1);
  browserHost.configureAiTransportHost({});
  expect(await collect(sharedStream)).toEqual([started, done]);

  const failedResultGate = Promise.withResolvers<void>();
  const iteratorError = new Error("custom iterator failed");
  const failedSource = {
    ...waitingSource(failedResultGate.promise),
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
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
