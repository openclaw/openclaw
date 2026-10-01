import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Model,
} from "@openclaw/llm-core";
import {
  createAssistantMessageEventStream,
  getEventStreamCompletion,
} from "@openclaw/llm-core/event-stream";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRegistry } from "./api-registry.js";
import {
  configureAiTransportHost,
  createAiTransportHost,
  getAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
} from "./host.js";
import { cleanupSessionResources, registerSessionResourceCleanup } from "./session-resources.js";
import { createLlmRuntime, createNodeLlmRuntime } from "./stream.js";

const original = getDefaultAiTransportHost();
afterEach(() => configureAiTransportHost(original));
const model: Model = {
  id: "scoped",
  name: "Scoped",
  provider: "fixture",
  api: "test-scoped",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: model.provider,
    model: model.id,
    api: model.api,
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function registryFor(resolve: (value: string) => Promise<string>) {
  const registry = createApiRegistry();
  const stream = (
    _model: Model,
    _context: unknown,
    options?: { apiKey?: string },
  ): AssistantMessageEventStreamContract => {
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
  };
  registry.registerApiProvider({ api: model.api, stream, streamSimple: stream });
  return registry;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("runtime-owned transport host", () => {
  it.each([false, true])("accepts frozen provider streams (scoped=%s)", async (scoped) => {
    const observations: string[] = [];
    const observe = (operation: string) =>
      observations.push(getAiTransportHost().resolveSecretSentinel(operation));
    const final = message("immutable producer");
    const source: AssistantMessageEventStreamContract = Object.freeze({
      push() {
        expect(this).toBe(source);
        observe("push");
      },
      end() {
        expect(this).toBe(source);
        observe("end");
      },
      async result() {
        expect(this).toBe(source);
        observe("result");
        return final;
      },
      [Symbol.asyncIterator]() {
        expect(this).toBe(source);
        observe("iterator");
        return {
          async next() {
            observe("next");
            return {
              done: false as const,
              value: { type: "done" as const, reason: "stop" as const, message: final },
            };
          },
          async return() {
            observe("return");
            return { done: true as const, value: undefined };
          },
          async throw(error: unknown) {
            observe("throw");
            throw error;
          },
        };
      },
    });
    const registry = createApiRegistry();
    registry.registerApiProvider({
      api: model.api,
      stream: () => source,
      streamSimple: () => source,
    });
    configureAiTransportHost({ resolveSecretSentinel: (value) => "gateway:" + value });
    const runtime = scoped
      ? createNodeLlmRuntime(registry, {
          resolveSecretSentinel: (value) => "scoped:" + value,
        })
      : createLlmRuntime(registry);
    for (const method of ["stream", "streamSimple"] as const) {
      const stream = runtime[method](model, { messages: [] });
      stream.push({ type: "done", reason: "stop", message: final });
      stream.end(final);
      expect(await stream.result()).toBe(final);
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({
        type: "done",
        reason: "stop",
        message: final,
      });
      const finish = iterator.return?.bind(iterator);
      const fail = iterator.throw?.bind(iterator);
      if (!finish || !fail) {
        throw new Error("fixture iterator must support early return and failure");
      }
      expect(await finish()).toEqual({ done: true, value: undefined });
      const error = new Error("iterator consumer stopped");
      await expect(fail(error)).rejects.toBe(error);
    }
    expect(await runtime.complete(model, { messages: [] })).toBe(final);
    expect(await runtime.completeSimple(model, { messages: [] })).toBe(final);
    expect(observations).toEqual(
      [
        "push",
        "end",
        "result",
        "iterator",
        "next",
        "return",
        "throw",
        "push",
        "end",
        "result",
        "iterator",
        "next",
        "return",
        "throw",
        "result",
        "result",
      ].map((value) => (scoped ? "scoped:" : "gateway:") + value),
    );
    expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("gateway:caller");
    expect(Object.isFrozen(source)).toBe(true);
  });

  it.each(["stream", "streamSimple"] as const)(
    "preserves native producer completion through %s without invoking result decorators",
    async (method) => {
      const source = createAssistantMessageEventStream();
      const result = source.result.bind(source);
      let resultCalls = 0;
      const decoratedResult = () => {
        resultCalls += 1;
        return result();
      };
      source.result = decoratedResult;
      const registry = createApiRegistry();
      const start = () => source;
      registry.registerApiProvider({
        api: model.api,
        stream: start,
        streamSimple: start,
      });
      Object.defineProperty(source, "result", { value: decoratedResult, writable: false });
      const runtime = createNodeLlmRuntime(registry);
      const scoped = runtime[method](model, { messages: [] });
      const completion = getEventStreamCompletion(scoped);
      expect(completion).toBe(getEventStreamCompletion(source));
      expect(resultCalls).toBe(0);
      const final = message("producer done");
      source.end(final);
      await expect(completion).resolves.toBe(final);
      expect(resultCalls).toBe(0);
      await expect(scoped.result()).resolves.toBe(final);
      expect(resultCalls).toBe(1);
    },
  );

  it("keeps overlapping native hosts separate while the ordinary runtime selects the current default", async () => {
    const gate = deferred();
    const registry = registryFor(async (value) => {
      await gate.promise;
      return getAiTransportHost().resolveSecretSentinel(value);
    });
    // Construct before installation: ordinary runtimes must not snapshot inert policy.
    const ordinary = createLlmRuntime(registry);
    const native = createNodeLlmRuntime(registry);
    const other = createNodeLlmRuntime(registry, {
      resolveSecretSentinel: (value) => "other:" + value,
    });
    configureAiTransportHost({
      resolveSecretSentinel: (value) => {
        if (value !== "known") {
          throw new Error("unknown Gateway credential");
        }
        return "Gateway-owned";
      },
    });
    const one = native.completeSimple(model, { messages: [] }, { apiKey: "opaque-one" });
    const two = other.completeSimple(model, { messages: [] }, { apiKey: "opaque-two" });
    const normal = ordinary.completeSimple(model, { messages: [] }, { apiKey: "known" });
    const refused = expect(
      ordinary.completeSimple(model, { messages: [] }, { apiKey: "unknown" }),
    ).rejects.toThrow("unknown Gateway");
    expect(() => getAiTransportHost().resolveSecretSentinel("unknown")).toThrow("unknown Gateway");
    gate.release();
    expect((await one).content).toEqual([{ type: "text", text: "opaque-one" }]);
    expect((await two).content).toEqual([{ type: "text", text: "other:opaque-two" }]);
    expect((await normal).content).toEqual([{ type: "text", text: "Gateway-owned" }]);
    await refused;
    expect(() => getAiTransportHost().resolveSecretSentinel("unknown")).toThrow("unknown Gateway");
  });

  it("binds an ordinary stream to the default host selected when it starts", async () => {
    configureAiTransportHost({ resolveSecretSentinel: (value) => "first:" + value });
    const runtime = createLlmRuntime(
      registryFor(async (value) => getAiTransportHost().resolveSecretSentinel(value)),
    );
    const stream = runtime.streamSimple(model, { messages: [] }, { apiKey: "opaque" });

    configureAiTransportHost({ resolveSecretSentinel: (value) => "replacement:" + value });

    expect((await stream.result()).content).toEqual([{ type: "text", text: "first:opaque" }]);
    expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("replacement:caller");
  });

  it("does not let a nested ordinary runtime inherit native policy", async () => {
    configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
    const ordinary = createLlmRuntime(
      registryFor(async (value) => getAiTransportHost().resolveSecretSentinel(value)),
    );
    const native = createNodeLlmRuntime(
      registryFor(async (value) => {
        await Promise.resolve();
        expect(getAiTransportHost().resolveSecretSentinel(value)).toBe(value);
        const nested = await ordinary.complete(model, { messages: [] }, { apiKey: value });
        expect(nested.content).toEqual([{ type: "text", text: "Gateway:" + value }]);
        return getAiTransportHost().resolveSecretSentinel(value);
      }),
    );
    expect((await native.complete(model, { messages: [] }, { apiKey: "opaque" })).content).toEqual([
      { type: "text", text: "opaque" },
    ]);
  });

  it("keeps process installers independent of an active scoped host", async () => {
    configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
    await runWithAiTransportHost(createAiTransportHost(), async () => {
      await Promise.resolve();
      configureAiTransportHost({ ...getDefaultAiTransportHost(), logInfo: () => {} });
      expect(getAiTransportHost().resolveSecretSentinel("opaque")).toBe("opaque");
    });
    expect(getAiTransportHost().resolveSecretSentinel("opaque")).toBe("Gateway:opaque");
  });

  it("passes each explicit runtime owner to session-resource cleanup", () => {
    const calls: Array<{ sessionId: string | undefined; owner: object | undefined }> = [];
    const unregister = registerSessionResourceCleanup((sessionId, owner) => {
      calls.push({ sessionId, owner });
    });
    try {
      const first = createNodeLlmRuntime();
      const second = createNodeLlmRuntime();
      first.cleanupSessionResources("shared");
      second.cleanupSessionResources();
      cleanupSessionResources("global");

      expect(calls.map(({ sessionId }) => sessionId)).toEqual(["shared", undefined, "global"]);
      expect(calls[0]?.owner).toBeDefined();
      expect(calls[1]?.owner).toBeDefined();
      expect(calls[0]?.owner).not.toBe(calls[1]?.owner);
      expect(calls[2]?.owner).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("cleans every default host used by an ordinary runtime after replacement", () => {
    const owners: object[] = [];
    const unregister = registerSessionResourceCleanup((_sessionId, owner) => {
      if (owner) {
        owners.push(owner);
      }
    });
    try {
      configureAiTransportHost({ resolveSecretSentinel: (value) => "first:" + value });
      const firstHost = getDefaultAiTransportHost();
      const runtime = createLlmRuntime(registryFor(async (value) => value));
      runtime.streamSimple(model, { messages: [] }, { apiKey: "opaque", sessionId: "shared" });

      configureAiTransportHost({ resolveSecretSentinel: (value) => "replacement:" + value });
      const replacementHost = getDefaultAiTransportHost();
      runtime.cleanupSessionResources("shared");
      runtime.cleanupSessionResources("shared");

      expect(owners).toEqual([firstHost, replacementHost, replacementHost]);

      owners.length = 0;
      runtime.streamSimple(model, { messages: [] }, { apiKey: "opaque", sessionId: "package" });
      configureAiTransportHost({ resolveSecretSentinel: (value) => "latest:" + value });
      const latestHost = getDefaultAiTransportHost();
      cleanupSessionResources("package");
      runtime.cleanupSessionResources("package");
      expect(owners).toEqual([latestHost]);
    } finally {
      unregister();
    }
  });

  it.each(["stream", "streamSimple"] as const)(
    "binds lazy %s iteration and early return without leaking the caller context",
    async (method) => {
      const observations: string[] = [];
      const registry = createApiRegistry();
      const stream = (): AssistantMessageEventStreamContract => ({
        push() {},
        end() {},
        result: async () => message("done"),
        async *[Symbol.asyncIterator]() {
          try {
            await Promise.resolve();
            observations.push(getAiTransportHost().resolveSecretSentinel("iterate"));
            yield { type: "start", partial: message("start") };
          } finally {
            await Promise.resolve();
            observations.push(getAiTransportHost().resolveSecretSentinel("return"));
          }
        },
      });
      registry.registerApiProvider({ api: model.api, stream, streamSimple: stream });
      configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
      const native = createNodeLlmRuntime(registry);
      const scoped = native[method](model, { messages: [] });
      const iterator = scoped[Symbol.asyncIterator]();
      const iterateSelf = Reflect.get(iterator, Symbol.asyncIterator);
      if (typeof iterateSelf !== "function") {
        throw new Error("bound provider iterator must remain async iterable");
      }
      expect(Reflect.apply(iterateSelf, iterator, [])).toBe(iterator);
      for await (const event of scoped) {
        expect(event.type).toBe("start");
        expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("Gateway:caller");
        break;
      }
      expect(observations).toEqual(["iterate", "return"]);
    },
  );
});
