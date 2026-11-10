import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Model,
} from "@openclaw/llm-core";
import {
  createAssistantMessageEventStream,
  getEventStreamCompletion,
} from "@openclaw/llm-core/event-stream";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createApiRegistry, type ApiStreamFunction } from "./api-registry.js";
import {
  configureAiTransportHost,
  createAiTransportHost,
  getAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
} from "./host.js";
import * as publicAi from "./index.js";
import {
  defaultApiRegistry,
  streamSimple as streamSimpleDefault,
} from "./internal/default-runtime.js";
import {
  anthropicModel,
  assistantMessage,
  textBlock,
  userMessage,
} from "./provider-transport-parity.test-support.js";
import { makeProviderModel } from "./providers/provider-model.test-support.js";
import { cleanupSessionResources, registerSessionResourceCleanup } from "./session-resources.js";
import { createLlmRuntime, createNodeLlmRuntime } from "./stream.js";

const original = getDefaultAiTransportHost();
afterEach(() => configureAiTransportHost(original));
const context = { messages: [] };
const host = (prefix: string) => ({ resolveSecretSentinel: (value: string) => prefix + value });
const resolveSecret = (value: string) => getAiTransportHost().resolveSecretSentinel(value);
const textContent = (text: string) => [textBlock(text)];
const model: Model = makeProviderModel("test-scoped", "fixture", "scoped");
function message(text: string): AssistantMessage {
  return assistantMessage(model, textContent(text));
}
function registryForStream(stream: ApiStreamFunction) {
  const registry = createApiRegistry();
  registry.registerApiProvider({ api: model.api, stream, streamSimple: stream });
  return registry;
}
function registryFor(resolve: (value: string) => Promise<string>) {
  return registryForStream((_model, _context, options): AssistantMessageEventStreamContract => {
    const result = async () => message(await resolve(options?.apiKey ?? ""));
    return {
      push() {},
      end() {},
      result,
      async *[Symbol.asyncIterator]() {
        const final = await result();
        yield { type: "done", reason: "stop", message: final };
      },
    };
  });
}
type Cleanup = Parameters<typeof registerSessionResourceCleanup>[0];
function withCleanup(run: (cleanup: Mock<Cleanup>) => void | Promise<void>) {
  const cleanup = vi.fn<Cleanup>();
  const unregister = registerSessionResourceCleanup(cleanup);
  return Promise.resolve()
    .then(() => run(cleanup))
    .finally(unregister);
}

describe("transport host installation and registry", () => {
  const sourceId = "test:llm-runtime-api-registry";
  const registryModel = { ...anthropicModel, api: "test-api" };
  const emptyStream = () => publicAi.createAssistantMessageEventStream();
  const provider = (api = "test-api", streamSimple = emptyStream) => ({
    api,
    stream: emptyStream,
    streamSimple,
  });
  afterEach(() => defaultApiRegistry.unregisterApiProviders(sourceId));

  it("rejects mismatched model API calls", () => {
    const registry = publicAi.createApiRegistry();
    registry.registerApiProvider(provider(), sourceId);
    expect(() =>
      registry
        .getApiProvider("test-api")
        ?.streamSimple({ ...registryModel, api: "other-api" }, context),
    ).toThrow("Mismatched api: other-api expected test-api");
  });

  it("isolates providers between runtime instances", () => {
    const first = publicAi.createLlmRuntime();
    const second = publicAi.createLlmRuntime();
    const streamSimple = vi.fn(emptyStream);
    first.registry.registerApiProvider(provider("test-api", streamSimple));
    first.streamSimple(registryModel, context);
    expect(streamSimple).toHaveBeenCalledOnce();
    expect(() => second.streamSimple(registryModel, context)).toThrow(
      "No API provider registered for api: test-api",
    );
  });

  it("shares default runtime registrations across duplicated module instances", async () => {
    // File URLs preserve the query through Vitest project shards.
    const duplicate = (await import(
      /* @vite-ignore */ new URL("./internal/default-runtime.ts?duplicate-runtime", import.meta.url)
        .href
    )) as typeof import("./internal/default-runtime.js");
    const streamSimple = vi.fn(emptyStream);
    duplicate.defaultApiRegistry.registerApiProvider(provider("test-api", streamSimple), sourceId);
    streamSimpleDefault(registryModel, context);
    expect(streamSimple).toHaveBeenCalledOnce();
  });

  it("unregisters every provider owned by one source", () => {
    const registry = publicAi.createApiRegistry();
    for (const api of ["test-api", "test-api-2"]) {
      registry.registerApiProvider(provider(api), sourceId);
    }
    registry.unregisterApiProviders(sourceId);
    expect(registry.getApiProviders()).toEqual([]);
  });

  it("replays custom API registration when transports load before the concrete host", async () => {
    const { prepareModelForSimpleCompletion } = await import("./transports.js");
    configureAiTransportHost({});
    const registry = createApiRegistry();
    const sourceModel = {
      ...anthropicModel,
      api: "openai-chatgpt-responses" as const,
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const customApi = "openclaw-openai-chatgpt-responses-transport";
    const prepare = () =>
      prepareModelForSimpleCompletion({ apiRegistry: registry, model: sourceModel });
    expect(prepare()).toBe(sourceModel);
    expect(registry.getApiProvider(customApi)).toBeUndefined();
    const registrar = vi.fn<import("./host.js").AiTransportHost["registerCustomApi"]>(
      (target, api) => {
        target.registerApiProvider(provider(api));
        return true;
      },
    );
    configureAiTransportHost({ registerCustomApi: registrar });
    configureAiTransportHost({ registerCustomApi: registrar });
    expect(registrar).toHaveBeenCalledOnce();
    const registered = registry.getApiProvider(customApi);
    const configuredModel = prepare();
    expect(configuredModel.api).toBe(customApi);
    expect(registered?.streamSimple(configuredModel, context)).toHaveProperty("result");
  });

  it("uses package transcript normalization until the embedding host overrides it", () => {
    configureAiTransportHost({});
    const messages = [userMessage([{ type: "image", data: "aW1n", mimeType: "image/png" }])];
    const targetModel = { ...anthropicModel, reasoning: false };
    expect(getAiTransportHost().transformTransportMessages(messages, targetModel)).toEqual([
      userMessage([textBlock("(image omitted: model does not support images)")]),
    ]);
    configureAiTransportHost({ transformTransportMessages: (next) => next });
    expect(getAiTransportHost().transformTransportMessages(messages, targetModel)).toBe(messages);
  });
});
describe("runtime-owned transport host", () => {
  it.each([false, true])("accepts frozen provider streams (scoped=%s)", async (scoped) => {
    const observations: string[] = [];
    const observe = (operation: string) => observations.push(resolveSecret(operation));
    const final = message("immutable producer");
    const done = { type: "done" as const, reason: "stop" as const, message: final };
    const withReceiver = <T>(operation: string, run: () => T) =>
      function (this: unknown) {
        expect(this).toBe(source);
        observe(operation);
        return run();
      };
    const source: AssistantMessageEventStreamContract = Object.freeze({
      push: withReceiver("push", () => {}),
      end: withReceiver("end", () => {}),
      result: withReceiver("result", async () => final),
      [Symbol.asyncIterator]: withReceiver("iterator", () => ({
        async next() {
          observe("next");
          return { done: false as const, value: done };
        },
        async return() {
          observe("return");
          return { done: true as const, value: undefined };
        },
        async throw(error: unknown) {
          observe("throw");
          throw error;
        },
      })),
    });
    const registry = registryForStream(() => source);
    configureAiTransportHost(host("gateway:"));
    const runtime = scoped
      ? createNodeLlmRuntime(registry, host("scoped:"))
      : createLlmRuntime(registry);
    for (const method of ["stream", "streamSimple"] as const) {
      const stream = runtime[method](model, context);
      stream.push(done);
      stream.end(final);
      expect(await stream.result()).toBe(final);
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual(done);
      await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
      const error = new Error("iterator consumer stopped");
      await expect(iterator.throw?.(error)).rejects.toBe(error);
    }
    expect(await runtime.complete(model, context)).toBe(final);
    expect(await runtime.completeSimple(model, context)).toBe(final);
    const operations = "push end result iterator next return throw".split(" ");
    expect(observations).toEqual(
      [...operations, ...operations, "result", "result"].map(
        (value) => (scoped ? "scoped:" : "gateway:") + value,
      ),
    );
    expect(resolveSecret("caller")).toBe("gateway:caller");
  });

  it.each(["stream", "streamSimple"] as const)(
    "preserves native completion without %s result decorators",
    async (method) => {
      const source = createAssistantMessageEventStream();
      const decoratedResult = vi.fn(source.result.bind(source));
      source.result = decoratedResult;
      Object.defineProperty(source, "result", { value: decoratedResult, writable: false });
      const runtime = createNodeLlmRuntime(registryForStream(() => source));
      const scoped = runtime[method](model, context);
      const completion = getEventStreamCompletion(scoped);
      expect(completion).toBe(getEventStreamCompletion(source));
      expect(decoratedResult).not.toHaveBeenCalled();
      const final = message("producer done");
      source.end(final);
      await expect(completion).resolves.toBe(final);
      expect(decoratedResult).not.toHaveBeenCalled();
      await expect(scoped.result()).resolves.toBe(final);
      expect(decoratedResult).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps overlapping native hosts separate while the ordinary runtime selects the current default", async () => {
    const gate = Promise.withResolvers<void>();
    const registry = registryFor(async (value) => {
      await gate.promise;
      return resolveSecret(value);
    });
    // Construct before installation: ordinary runtimes must not snapshot inert policy.
    const ordinary = createLlmRuntime(registry);
    const native = createNodeLlmRuntime(registry);
    const other = createNodeLlmRuntime(registry, host("other:"));
    configureAiTransportHost({
      resolveSecretSentinel: (value) => {
        if (value !== "known") {
          throw new Error("unknown Gateway credential");
        }
        return "Gateway-owned";
      },
    });
    const one = native.completeSimple(model, context, { apiKey: "opaque-one" });
    const two = other.completeSimple(model, context, { apiKey: "opaque-two" });
    const normal = ordinary.completeSimple(model, context, { apiKey: "known" });
    const refused = expect(
      ordinary.completeSimple(model, context, { apiKey: "unknown" }),
    ).rejects.toThrow("unknown Gateway");
    expect(() => resolveSecret("unknown")).toThrow("unknown Gateway");
    gate.resolve();
    expect((await one).content).toEqual(textContent("opaque-one"));
    expect((await two).content).toEqual(textContent("other:opaque-two"));
    expect((await normal).content).toEqual(textContent("Gateway-owned"));
    await refused;
    expect(() => resolveSecret("unknown")).toThrow("unknown Gateway");
  });

  it("does not let a nested ordinary runtime inherit native policy", async () => {
    configureAiTransportHost(host("Gateway:"));
    const ordinary = createLlmRuntime(registryFor(async (value) => resolveSecret(value)));
    const native = createNodeLlmRuntime(
      registryFor(async (value) => {
        await Promise.resolve();
        expect(resolveSecret(value)).toBe(value);
        const nested = await ordinary.complete(model, context, { apiKey: value });
        expect(nested.content).toEqual(textContent("Gateway:" + value));
        return resolveSecret(value);
      }),
    );
    expect((await native.complete(model, context, { apiKey: "opaque" })).content).toEqual(
      textContent("opaque"),
    );
  });

  it("keeps process installers independent of an active scoped host", async () => {
    configureAiTransportHost(host("Gateway:"));
    await runWithAiTransportHost(createAiTransportHost(), async () => {
      await Promise.resolve();
      configureAiTransportHost({ ...getDefaultAiTransportHost(), logInfo: () => {} });
      expect(resolveSecret("opaque")).toBe("opaque");
    });
    expect(resolveSecret("opaque")).toBe("Gateway:opaque");
  });

  it("passes each explicit runtime owner to session-resource cleanup", () =>
    withCleanup((cleanup) => {
      const first = createNodeLlmRuntime();
      const second = createNodeLlmRuntime();
      first.cleanupSessionResources("shared");
      second.cleanupSessionResources();
      cleanupSessionResources("global");

      const calls = cleanup.mock.calls;
      expect(calls.map(([sessionId]) => sessionId)).toEqual(["shared", undefined, "global"]);
      expect(calls[0]?.[1]).toBeDefined();
      expect(calls[1]?.[1]).toBeDefined();
      expect(calls[0]?.[1]).not.toBe(calls[1]?.[1]);
      expect(calls[2]?.[1]).toBeUndefined();
    }));

  it("binds ordinary streams to their host and cleans the current default", () =>
    withCleanup(async (cleanup) => {
      configureAiTransportHost(host("first:"));
      const runtime = createLlmRuntime(registryFor(async (value) => resolveSecret(value)));
      const stream = runtime.streamSimple(model, context, {
        apiKey: "opaque",
        sessionId: "shared",
      });

      configureAiTransportHost(host("replacement:"));
      const replacementHost = getDefaultAiTransportHost();
      expect((await stream.result()).content).toEqual(textContent("first:opaque"));
      expect(resolveSecret("caller")).toBe("replacement:caller");
      runtime.cleanupSessionResources("shared");
      runtime.cleanupSessionResources("shared");

      expect(cleanup.mock.calls).toEqual([
        ["shared", replacementHost],
        ["shared", replacementHost],
      ]);
    }));

  it.each(["stream", "streamSimple"] as const)(
    "binds lazy %s and early return without caller-context leaks",
    async (method) => {
      const observations: string[] = [];
      const registry = registryForStream((): AssistantMessageEventStreamContract => ({
        push() {},
        end() {},
        result: async () => message("done"),
        async *[Symbol.asyncIterator]() {
          try {
            await Promise.resolve();
            observations.push(resolveSecret("iterate"));
            yield { type: "start", partial: message("start") };
          } finally {
            await Promise.resolve();
            observations.push(resolveSecret("return"));
          }
        },
      }));
      configureAiTransportHost(host("Gateway:"));
      const native = createNodeLlmRuntime(registry);
      const scoped = native[method](model, context);
      const iterator = scoped[Symbol.asyncIterator]();
      const iterateSelf = Reflect.get(iterator, Symbol.asyncIterator);
      if (typeof iterateSelf !== "function") {
        throw new Error("bound provider iterator must remain async iterable");
      }
      expect(Reflect.apply(iterateSelf, iterator, [])).toBe(iterator);
      for await (const event of scoped) {
        expect(event.type).toBe("start");
        expect(resolveSecret("caller")).toBe("Gateway:caller");
        break;
      }
      expect(observations).toEqual(["iterate", "return"]);
    },
  );
});
