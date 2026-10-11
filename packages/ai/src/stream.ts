import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
} from "@openclaw/llm-core";
import {
  bindAssistantMessageEventStream,
  getEventStreamCompletion,
} from "@openclaw/llm-core/event-stream";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import {
  createAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
  supportsScopedAiTransportHosts,
  type AiTransportHost,
} from "./host.js";
import { cleanupSessionResources as cleanupRegisteredSessionResources } from "./session-resources.js";

function retainUnscopedStreamLifetime(
  stream: AssistantMessageEventStreamContract,
  runWithHost: <T>(operation: () => T) => T,
): AssistantMessageEventStreamContract {
  let releaseLifetime!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    releaseLifetime = resolve;
  });
  void runWithHost(() => lifetime);
  let released = false;
  let resultSettled = false;
  let bufferSettled = false;
  const releaseIfSettled = () => {
    if (!released && resultSettled && bufferSettled) {
      released = true;
      releaseLifetime();
    }
  };
  const push = stream.push.bind(stream);
  const end = stream.end.bind(stream);
  const result = stream.result.bind(stream);
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  const bufferedEvents: AssistantMessageEvent[] = [];
  const bufferWaiters = new Set<() => void>();
  let bufferError: Error | undefined;
  let resultPromise: ReturnType<typeof result> | undefined;
  const notifyBufferWaiters = () => {
    for (const resolve of bufferWaiters) {
      resolve();
    }
    bufferWaiters.clear();
  };
  const observeResult = () => {
    if (!resultPromise) {
      let providerResult: ReturnType<typeof result>;
      try {
        providerResult = runWithHost(result);
      } catch (error) {
        providerResult = Promise.reject(new Error("Stream result failed", { cause: error }));
      }
      const settleResult = () => {
        resultSettled = true;
        releaseIfSettled();
      };
      void providerResult.then(settleResult, settleResult);
      resultPromise = providerResult;
    }
    return resultPromise;
  };
  void (async () => {
    try {
      const iterator = runWithHost(iterate);
      while (true) {
        const next = await runWithHost(() => iterator.next());
        if (next.done) {
          return;
        }
        bufferedEvents.push(next.value);
        notifyBufferWaiters();
      }
    } catch (error) {
      bufferError = new Error("Stream iteration failed", { cause: error });
    } finally {
      bufferSettled = true;
      notifyBufferWaiters();
      void observeResult().catch(() => {});
      releaseIfSettled();
    }
  })();
  return {
    push: (event) => runWithHost(() => push(event)),
    end: (message) => runWithHost(() => end(message)),
    result: observeResult,
    [Symbol.asyncIterator]() {
      let index = 0;
      let done = false;
      const next = async (): Promise<IteratorResult<AssistantMessageEvent>> => {
        if (done) {
          return { done: true, value: undefined };
        }
        if (index < bufferedEvents.length) {
          const value = bufferedEvents[index];
          if (value === undefined) {
            throw new Error("Buffered stream event is missing");
          }
          index += 1;
          return { done: false, value };
        }
        if (bufferSettled) {
          if (bufferError) {
            throw bufferError;
          }
          done = true;
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => {
          bufferWaiters.add(resolve);
        });
        return next();
      };
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next,
        async return(value?: unknown) {
          done = true;
          notifyBufferWaiters();
          return { done: true as const, value };
        },
      };
    },
  };
}

function createRuntime(registry: ApiRegistry, transportHost?: Partial<AiTransportHost>) {
  const explicitHost =
    transportHost === undefined ? undefined : createAiTransportHost(transportHost);
  const resolveRuntimeHost = () => explicitHost ?? getDefaultAiTransportHost();
  const startStream = (start: () => AssistantMessageEventStreamContract) => {
    const host = resolveRuntimeHost();
    const runWithStreamHost = <T>(operation: () => T): T => runWithAiTransportHost(host, operation);
    const started = runWithStreamHost(start);
    const completion = getEventStreamCompletion(started);
    const bound = bindAssistantMessageEventStream(started, runWithStreamHost);
    if (completion) {
      if (!supportsScopedAiTransportHosts()) {
        let producerSettled = false;
        const observedCompletion = completion.finally(() => {
          producerSettled = true;
        });
        void runWithStreamHost(() => observedCompletion);
        const result = runWithStreamHost(() => started.result());
        return bindAssistantMessageEventStream(
          started,
          (operation) => (producerSettled ? operation() : runWithStreamHost(operation)),
          {
            result: () => result,
          },
        );
      }
      void runWithStreamHost(() => completion);
    }
    return !completion && !supportsScopedAiTransportHosts()
      ? retainUnscopedStreamLifetime(started, runWithStreamHost)
      : bound;
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

  function cleanupSessionResources(sessionId?: string): void {
    if (!supportsScopedAiTransportHosts()) {
      cleanupRegisteredSessionResources(sessionId);
      return;
    }
    const host = resolveRuntimeHost();
    try {
      runWithAiTransportHost(host, () => cleanupRegisteredSessionResources(sessionId, host));
    } catch (error) {
      throw new AggregateError([error], "Failed to cleanup runtime session resources");
    }
  }

  return {
    registry,
    stream,
    complete,
    streamSimple,
    completeSimple,
    cleanupSessionResources,
  };
}

/** Creates an isolated LLM runtime backed by the supplied provider registry. */
export function createLlmRuntime(registry: ApiRegistry = createApiRegistry()) {
  return createRuntime(registry);
}

/** Creates a Node runtime whose provider work retains an explicit transport host. */
export function createNodeLlmRuntime(
  registry: ApiRegistry = createApiRegistry(),
  transportHost: Partial<AiTransportHost> = {},
) {
  if (!supportsScopedAiTransportHosts()) {
    throw new Error("Explicit AI transport hosts require Node.js async context support");
  }
  return createRuntime(registry, transportHost);
}

export type LlmRuntime = ReturnType<typeof createLlmRuntime>;
