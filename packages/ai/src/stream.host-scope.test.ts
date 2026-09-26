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
import { createLlmRuntime } from "./stream.js";

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
  it.each(["stream", "streamSimple"] as const)(
    "preserves native producer completion through %s without invoking result decorators",
    async (method) => {
      const source = createAssistantMessageEventStream();
      const result = source.result.bind(source);
      let resultCalls = 0;
      source.result = () => {
        resultCalls += 1;
        return result();
      };
      const registry = createApiRegistry();
      registry.registerApiProvider({
        api: model.api,
        stream: () => source,
        streamSimple: () => source,
      });
      const runtime = createLlmRuntime(registry, { transportHost: {} });
      const scoped = runtime[method](model, { messages: [] });
      expect(scoped).toBe(source);
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
    const native = createLlmRuntime(registry, { transportHost: {} });
    const other = createLlmRuntime(registry, {
      transportHost: { resolveSecretSentinel: (value) => "other:" + value },
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

  it("does not let a nested ordinary runtime inherit native policy", async () => {
    configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
    const ordinary = createLlmRuntime(
      registryFor(async (value) => getAiTransportHost().resolveSecretSentinel(value)),
    );
    const native = createLlmRuntime(
      registryFor(async (value) => {
        await Promise.resolve();
        expect(getAiTransportHost().resolveSecretSentinel(value)).toBe(value);
        const nested = await ordinary.complete(model, { messages: [] }, { apiKey: value });
        expect(nested.content).toEqual([{ type: "text", text: "Gateway:" + value }]);
        return getAiTransportHost().resolveSecretSentinel(value);
      }),
      { transportHost: {} },
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
      const native = createLlmRuntime(registry, { transportHost: {} });
      for await (const event of native[method](model, { messages: [] })) {
        expect(event.type).toBe("start");
        expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("Gateway:caller");
        break;
      }
      expect(observations).toEqual(["iterate", "return"]);
    },
  );
});
