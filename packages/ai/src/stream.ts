import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
} from "@openclaw/llm-core";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import {
  createAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
  type AiTransportHost,
} from "./host.js";

/** Creates an isolated LLM runtime backed by the supplied provider registry. */
export function createLlmRuntime(
  registry: ApiRegistry = createApiRegistry(),
  runtimeOptions: { transportHost?: Partial<AiTransportHost> } = {},
) {
  const explicitHost =
    runtimeOptions.transportHost === undefined
      ? undefined
      : createAiTransportHost(runtimeOptions.transportHost);
  const startStream = (
    start: () => AssistantMessageEventStreamContract,
  ): AssistantMessageEventStreamContract => {
    // A normal runtime uses its current embedding owner, even when invoked from
    // another runtime's callback. Do not capture the default during construction.
    const host = explicitHost ?? getDefaultAiTransportHost();
    const run = <T>(operation: () => T): T => runWithAiTransportHost(host, operation);
    const source = run(start);
    return {
      push: (event) => run(() => source.push(event)),
      end: (message) => run(() => source.end(message)),
      result: () => run(() => source.result()),
      [Symbol.asyncIterator]() {
        const iterator = run(() => source[Symbol.asyncIterator]());
        const finish = iterator.return?.bind(iterator);
        const fail = iterator.throw?.bind(iterator);
        return {
          next: (...args) => run(() => iterator.next(...args)),
          ...(finish ? { return: (value?: unknown) => run(() => finish(value)) } : {}),
          ...(fail ? { throw: (error?: unknown) => run(() => fail(error)) } : {}),
        };
      },
    };
  };
  function resolveApiProvider(api: Api) {
    const provider = registry.getApiProvider(api);
    if (!provider) {
      throw new Error(`No API provider registered for api: ${api}`);
    }
    return provider;
  }

  function stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ProviderStreamOptions,
  ): AssistantMessageEventStreamContract {
    return startStream(() =>
      resolveApiProvider(model.api).stream(model, context, options as StreamOptions),
    );
  }

  async function complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage> {
    return stream(model, context, options).result();
  }

  function streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStreamContract {
    return startStream(() => resolveApiProvider(model.api).streamSimple(model, context, options));
  }

  async function completeSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return streamSimple(model, context, options).result();
  }

  return { registry, stream, complete, streamSimple, completeSimple };
}

export type LlmRuntime = ReturnType<typeof createLlmRuntime>;
