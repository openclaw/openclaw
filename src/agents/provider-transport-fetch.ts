import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelProviderRetryConfig } from "../config/types.models.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { buildStatusRetryPredicate, resolveRetryConfig, retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  getModelProviderRetryConfig,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";

const log = createSubsystemLogger("provider-transport-fetch");

function buildManagedResponse(response: Response, release: () => Promise<void>): Response {
  if (!response.body) {
    void release();
    return response;
  }
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    await release().catch(() => undefined);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
  });
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function resolveModelRequestPolicy(model: Model<Api>) {
  return resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    request: getModelProviderRequestTransport(model),
  });
}

function buildRetryAwareFetch(
  baseFetch: typeof fetch,
  retryConfig: ModelProviderRetryConfig,
  provider: string,
): typeof fetch {
  const statusCodes = retryConfig.retryOnStatus;
  if (!statusCodes || statusCodes.length === 0) {
    return baseFetch;
  }
  const shouldRetry = buildStatusRetryPredicate(statusCodes);
  const resolved = resolveRetryConfig(
    { attempts: 3, minDelayMs: 1000, maxDelayMs: 60_000, jitter: 0.1, backoffFactor: 2 },
    {
      attempts: retryConfig.attempts,
      minDelayMs: retryConfig.minDelayMs,
      maxDelayMs: retryConfig.maxDelayMs,
      backoffFactor: retryConfig.backoffFactor,
    },
  );
  return async (input, init) =>
    retryAsync(
      async () => {
        const response = await baseFetch(input, init);
        if (!response.ok && statusCodes.includes(response.status)) {
          const err = new Error(
            `Provider ${provider} returned HTTP ${response.status}`,
          ) as Error & { status: number };
          err.status = response.status;
          throw err;
        }
        return response;
      },
      {
        ...resolved,
        shouldRetry,
        onRetry: (info) => {
          const maxRetries = Math.max(1, info.maxAttempts - 1);
          log.warn(
            `provider ${provider} retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms (status-based)`,
          );
        },
      },
    );
}

export function buildGuardedModelFetch(model: Model<Api>): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  const retryConfig = getModelProviderRetryConfig(model);
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const url =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const requestInit =
      request &&
      ({
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const result = await fetchWithSsrFGuard({
      url,
      init: requestInit ?? init,
      dispatcherPolicy,
      ...(requestConfig.allowPrivateNetwork ? { policy: { allowPrivateNetwork: true } } : {}),
    });
    return buildManagedResponse(result.response, result.release);
  };
  if (retryConfig?.retryOnStatus && retryConfig.retryOnStatus.length > 0) {
    return buildRetryAwareFetch(guardedFetch, retryConfig, model.provider);
  }
  return guardedFetch;
}
