import type { LlmRuntime } from "@openclaw/ai";
import { notifyLlmRequestActivity, onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { createBoundaryAwareStreamFnForModel } from "@openclaw/ai/transports";
import { hasNonEmptyString as hasResolvedRuntimeApiKey } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { getStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import { admitProviderRateLimitStream } from "../../llm/provider-rate-limit-stream.js";
import type { AssistantMessage, AssistantMessageEvent } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";
import type { StreamFn } from "../runtime/index.js";
import "../ai-transport-runtime-host.js";
import { createStreamIteratorWrapper } from "../stream-iterator-wrapper.js";
import { buildStreamErrorAssistantMessage } from "../stream-message-shared.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import { wrapStreamFnWithSessionFork, type EmbeddedSessionForkIdentity } from "./session-fork.js";

const embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();

type EmbeddedStreamOptions = Parameters<StreamFn>[2] & {
  authProfileId?: string;
  promptCacheKey?: string;
};

export function resolveEmbeddedAgentBaseStreamFn(params: {
  session: { agent: { streamFn?: StreamFn } };
}): StreamFn {
  if (!embeddedAgentBaseStreamFnCache.has(params.session)) {
    embeddedAgentBaseStreamFnCache.set(params.session, params.session.agent.streamFn);
  }
  const baseStreamFn = embeddedAgentBaseStreamFnCache.get(params.session);
  if (!baseStreamFn) {
    throw new Error("Agent session has no lifecycle-owned base stream.");
  }
  return baseStreamFn;
}

type EmbeddedStreamRuntimeOwner =
  | {
      llmRuntime: LlmRuntime;
      currentStreamFn: StreamFn | undefined;
    }
  | {
      llmRuntime?: never;
      currentStreamFn: StreamFn;
    };

function isDefaultOpenClawStreamFnForModel(
  model: EmbeddedRunAttemptParams["model"],
  streamFn: StreamFn | undefined,
  llmRuntime: LlmRuntime,
): boolean {
  if (!streamFn || streamFn === llmRuntime.streamSimple) {
    return true;
  }
  const api = model.api.trim();
  if (!api) {
    return false;
  }
  const provider = llmRuntime.registry.getApiProvider(api as never);
  return streamFn === provider?.streamSimple || streamFn === provider?.stream;
}

export async function resolveEmbeddedAgentApiKey(params: {
  provider: string;
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): Promise<string | undefined> {
  const resolvedApiKey = params.resolvedApiKey?.trim();
  if (resolvedApiKey) {
    return resolvedApiKey;
  }
  return params.authStorage ? await params.authStorage.getApiKey(params.provider) : undefined;
}

type EmbeddedAgentStreamParams = EmbeddedStreamRuntimeOwner & {
  providerStreamFn?: StreamFn;
  sessionId: string;
  promptCacheKey?: string;
  signal?: AbortSignal;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  transportAuthAvailable?: boolean;
  authProfileId?: string;
  authStorage?: {
    getApiKey(provider: string): Promise<string | undefined>;
    refreshApiKey?(provider: string, errorText: string): Promise<boolean>;
  };
  assertCurrent?: () => void;
  sessionFork?: EmbeddedSessionForkIdentity;
};

export function resolveEmbeddedAgentStream(params: EmbeddedAgentStreamParams): {
  streamFn: StreamFn;
  strategy: string;
} {
  const { streamFn, strategy, wrapApiKey } = selectEmbeddedAgentStream(params);
  return { streamFn: wrapApiKey(streamFn), strategy };
}

/**
 * Selects the embedded stream and returns its run-credential wrapper separately.
 * Callers that compose provider wrappers apply wrapApiKey outside them, because
 * those wrappers classify auth from options.apiKey.
 */
export function selectEmbeddedAgentStream(params: EmbeddedAgentStreamParams): {
  streamFn: StreamFn;
  strategy: string;
  /** Attaches the run credential when the selected transport sends it. */
  wrapApiKey: (streamFn: StreamFn) => StreamFn;
} {
  const llmRuntime = params.llmRuntime ?? getStreamLlmRuntime(params.currentStreamFn);
  if (!llmRuntime) {
    throw new Error("Embedded stream has no lifecycle runtime owner.");
  }
  const wrapOptions = {
    runSignal: params.signal,
    authProfileId: params.authProfileId,
    promptCacheKey: params.promptCacheKey,
    assertCurrent: params.assertCurrent,
    sessionFork: params.sessionFork,
  };
  const wrapRunApiKey = (streamFn: StreamFn) =>
    wrapEmbeddedAgentStreamApiKey(streamFn, {
      providerId: params.model.provider,
      resolvedApiKey: params.resolvedApiKey,
      authStorage: params.authStorage,
      assertCurrent: params.assertCurrent,
    });
  const wrapCredentialedStream = (
    streamFn: StreamFn,
    options: Parameters<typeof wrapEmbeddedAgentStreamFn>[1],
    strategy: string,
  ) => ({
    streamFn: wrapEmbeddedAgentStreamFn(streamFn, options),
    strategy,
    wrapApiKey: wrapRunApiKey,
  });
  // Vertex and session-owned streams resolve their own auth.
  const keepStreamAuth = (streamFn: StreamFn) => streamFn;
  const stripCacheBoundary = (context: Parameters<StreamFn>[1]) =>
    context.systemPrompt
      ? { ...context, systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt) }
      : context;
  if (params.providerStreamFn) {
    // Provider stream creation owns the plugin's cache-boundary capability.
    return wrapCredentialedStream(
      params.providerStreamFn,
      { ...wrapOptions, sessionFork: undefined },
      "provider",
    );
  }

  const currentStreamFn = params.currentStreamFn ?? llmRuntime.streamSimple;
  if (params.model.provider === "anthropic-vertex") {
    const vertexStreamFn = createAnthropicVertexStreamFnForModel(params.model);
    return {
      streamFn:
        params.signal || params.assertCurrent
          ? wrapEmbeddedAgentStreamFn(vertexStreamFn, {
              runSignal: params.signal,
              assertCurrent: params.assertCurrent,
            })
          : vertexStreamFn,
      strategy: "anthropic-vertex",
      wrapApiKey: keepStreamAuth,
    };
  }

  // Lifecycle-owned session streams retain their native transport through the
  // runtime binding even when auth/retry wrappers change function identity.
  if (
    params.model.provider === "openai" &&
    params.model.api === "openai-chatgpt-responses" &&
    (isDefaultOpenClawStreamFnForModel(params.model, params.currentStreamFn, llmRuntime) ||
      getStreamLlmRuntime(params.currentStreamFn) === llmRuntime)
  ) {
    return wrapCredentialedStream(
      currentStreamFn,
      { ...wrapOptions, sessionId: params.sessionId, transformContext: stripCacheBoundary },
      "openclaw-native-codex-responses",
    );
  }

  const isDefault = isDefaultOpenClawStreamFnForModel(
    params.model,
    params.currentStreamFn,
    llmRuntime,
  );
  if (
    isDefault ||
    hasResolvedRuntimeApiKey(params.resolvedApiKey) ||
    params.transportAuthAvailable ||
    // Proxied Anthropic streams need the managed transport's commentary tagging
    // even without a resolved key; direct Anthropic keeps its existing replay path.
    (params.model.api === "anthropic-messages" && params.model.provider !== "anthropic")
  ) {
    const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
    if (boundaryAwareStreamFn) {
      return wrapCredentialedStream(
        boundaryAwareStreamFn,
        { ...wrapOptions, sessionId: params.sessionId },
        `boundary-aware:${params.model.api}`,
      );
    }
  }

  const promptCacheKey = params.promptCacheKey?.trim();
  return {
    streamFn:
      !promptCacheKey && !params.signal && !params.assertCurrent && !params.sessionFork
        ? currentStreamFn
        : wrapEmbeddedAgentStreamFn(currentStreamFn, {
            runSignal: params.signal,
            promptCacheKey,
            assertCurrent: params.assertCurrent,
            sessionFork: params.sessionFork,
          }),
    strategy: isDefault ? "stream-simple" : "session-custom",
    wrapApiKey: keepStreamAuth,
  };
}

/** Preserve request activity across cancellation composition without retaining completed turns. */
function composeRunSignal(callerSignal: AbortSignal, runSignal: AbortSignal): AbortSignal {
  const composedSignal = AbortSignal.any([callerSignal, runSignal]);
  // The activity registry owns this bridge weakly; an abort listener on either
  // reusable source would retain its composite after a successful request.
  onLlmRequestActivity(composedSignal, (progress) => {
    if (!composedSignal.aborted) {
      notifyLlmRequestActivity(callerSignal, progress);
    }
  });
  return composedSignal;
}

function wrapEmbeddedAgentStreamFn(
  inner: StreamFn,
  params: {
    runSignal: AbortSignal | undefined;
    authProfileId?: string;
    sessionId?: string;
    promptCacheKey?: string;
    transformContext?: (context: Parameters<StreamFn>[1]) => Parameters<StreamFn>[1];
    assertCurrent?: () => void;
    sessionFork?: EmbeddedSessionForkIdentity;
  },
): StreamFn {
  const transformContext =
    params.transformContext ?? ((context: Parameters<StreamFn>[1]) => context);
  const transport = params.sessionFork
    ? wrapStreamFnWithSessionFork(inner, params.sessionFork)
    : inner;
  const mergeRunSignal = (options: Parameters<StreamFn>[2]) => {
    const embeddedOptions = options as EmbeddedStreamOptions | undefined;
    const callerSignal = embeddedOptions?.signal;
    const signal =
      callerSignal && params.runSignal && callerSignal !== params.runSignal
        ? composeRunSignal(callerSignal, params.runSignal)
        : (callerSignal ?? params.runSignal);
    let merged =
      params.sessionId && !embeddedOptions?.sessionId
        ? { ...embeddedOptions, sessionId: params.sessionId }
        : embeddedOptions;
    const promptCacheKey = params.promptCacheKey?.trim();
    if (promptCacheKey && !merged?.promptCacheKey) {
      merged = { ...merged, promptCacheKey };
    }
    if (params.authProfileId && !merged?.authProfileId) {
      merged = { ...merged, authProfileId: params.authProfileId };
    }
    return signal ? { ...merged, signal } : merged;
  };
  return (m, context, options) => {
    params.assertCurrent?.();
    const mergedOptions = mergeRunSignal(options);
    return admitProviderRateLimitStream(
      m,
      mergedOptions,
      (admittedOptions) => transport(m, transformContext(context), admittedOptions),
      params.assertCurrent,
    );
  };
}

/** Resolve the run credential for each request and pass it to every inner wrapper. */
function wrapEmbeddedAgentStreamApiKey(
  inner: StreamFn,
  params: {
    providerId: string;
    resolvedApiKey?: string;
    authStorage?: {
      getApiKey(provider: string): Promise<string | undefined>;
      refreshApiKey?(provider: string, errorText: string): Promise<boolean>;
    };
    assertCurrent?: () => void;
  },
): StreamFn {
  if (!params.authStorage && !params.resolvedApiKey) {
    return inner;
  }
  const { authStorage, providerId, resolvedApiKey } = params;
  const refreshAuth = authStorage?.refreshApiKey?.bind(authStorage);
  return async (m, context, options) => {
    const resolveApiKey = async () => {
      params.assertCurrent?.();
      const apiKey = await resolveEmbeddedAgentApiKey({
        provider: providerId,
        resolvedApiKey,
        authStorage,
      });
      params.assertCurrent?.();
      return apiKey ?? options?.apiKey;
    };
    const start = (apiKey: string | undefined) =>
      inner(m, context, { ...options, apiKey: apiKey ?? options?.apiKey });
    if (!refreshAuth) {
      return start(await resolveApiKey());
    }
    return createAuthRecoveryStream({
      model: m,
      start,
      resolveApiKey,
      refreshAuth: (errorText) => refreshAuth(providerId, errorText),
      assertCurrent: params.assertCurrent,
    });
  };
}

function isStructuredTokenExpiredError(error: AssistantMessage): boolean {
  if (error.stopReason !== "error") {
    return false;
  }
  const errorCode = error.errorCode?.trim().toLowerCase();
  if (errorCode) {
    return errorCode === "token_expired";
  }
  return /\btoken_expired\b|authentication token is expired/iu.test(error.errorMessage ?? "");
}

/**
 * Retries one explicitly rejected model request after renewing its selected
 * profile credential. The outer attempt replay gate remains authoritative.
 */
function createAuthRecoveryStream(params: {
  model: Parameters<StreamFn>[0];
  start: (apiKey: string | undefined) => ReturnType<StreamFn>;
  resolveApiKey: () => Promise<string | undefined>;
  refreshAuth: (errorText: string) => Promise<boolean>;
  assertCurrent?: () => void;
}): ReturnType<StreamFn> {
  const outer = createAssistantMessageEventStream();
  const trackCleanup = captureAsyncWorkTracker();
  let activeIterator: AsyncIterator<AssistantMessageEvent> | undefined;
  let consumerClosed = false;
  const closeIterator = (iterator: AsyncIterator<AssistantMessageEvent>) => {
    try {
      const closing = iterator.return?.();
      if (closing) {
        void trackCleanup(() => closing).catch(() => recordAgentCleanupFailure());
      }
    } catch {
      recordAgentCleanupFailure();
    }
  };
  const originalAsyncIterator = outer[Symbol.asyncIterator].bind(outer);
  outer[Symbol.asyncIterator] = function () {
    return createStreamIteratorWrapper({
      iterator: originalAsyncIterator(),
      next: (iterator) => iterator.next(),
      onReturn: async (iterator, value) => {
        consumerClosed = true;
        const active = activeIterator;
        activeIterator = undefined;
        // The pump owns the provider iterator; close it before releasing the consumer.
        if (active) {
          closeIterator(active);
        }
        // Release the outer iterator parked on the next event before forwarding return.
        outer.end();
        return (await iterator.return?.(value)) ?? { done: true, value: undefined };
      },
    });
  };
  void Promise.resolve().then(async () => {
    let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
    const flushStart = () => {
      if (pendingStart) {
        outer.push(pendingStart);
        pendingStart = undefined;
      }
    };
    try {
      let acceptedContent = false;
      let refreshed = false;
      while (true) {
        if (consumerClosed) {
          return;
        }
        const stream = await params.start(await params.resolveApiKey());
        if (consumerClosed) {
          closeIterator(stream[Symbol.asyncIterator]());
          return;
        }
        const iterator = stream[Symbol.asyncIterator]();
        activeIterator = iterator;
        let restart = false;
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            const event = next.value;
            if (consumerClosed) {
              return;
            }
            if (event.type === "start" && !acceptedContent) {
              pendingStart ??= event;
              continue;
            }
            if (event.type === "error") {
              let renew = false;
              if (!refreshed && !acceptedContent && isStructuredTokenExpiredError(event.error)) {
                try {
                  renew = await params.refreshAuth(event.error.errorMessage ?? "");
                } catch {
                  renew = false;
                }
              }
              if (renew) {
                params.assertCurrent?.();
                refreshed = true;
                pendingStart = undefined;
                restart = true;
                break;
              }
              flushStart();
              outer.push(event);
              acceptedContent = true;
              continue;
            }
            flushStart();
            outer.push(event);
            acceptedContent = true;
          }
        } finally {
          if (activeIterator === iterator) {
            activeIterator = undefined;
          }
          closeIterator(iterator);
        }
        if (consumerClosed) {
          return;
        }
        if (restart) {
          continue;
        }
        flushStart();
        outer.end(await stream.result());
        return;
      }
    } catch (error) {
      const message = buildStreamErrorAssistantMessage({
        model: {
          api: params.model.api,
          provider: params.model.provider,
          id: params.model.id,
        },
        errorMessage: formatErrorMessage(error),
      });
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    }
  });
  return outer;
}
