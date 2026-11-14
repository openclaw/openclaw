import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth-markers";
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { createProviderNativeStreamFn } from "openclaw/plugin-sdk/provider-stream-family";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveClawRouterOllamaRoute } from "./provider-catalog.js";

export function createClawRouterOllamaStream(
  ctx: Parameters<NonNullable<ProviderPlugin["createStreamFn"]>>[0],
): StreamFn | undefined {
  if (ctx.model.api !== "ollama") {
    return undefined;
  }
  const route = resolveClawRouterOllamaRoute(ctx.model);
  return async (model, context, options) => {
    // Catalog discovery precedes this invocation and owns a separate budget.
    const suppliedTimeout =
      readRecord(options)?.requestTimeoutMs ??
      options?.timeoutMs ??
      readRecord(model)?.requestTimeoutMs;
    const timeoutMs =
      typeof suppliedTimeout === "number" && Number.isFinite(suppliedTimeout) && suppliedTimeout > 0
        ? suppliedTimeout
        : undefined;
    const deadline = createProviderOperationDeadline({ timeoutMs, label: "ClawRouter Ollama" });
    const remaining = () =>
      timeoutMs === undefined
        ? undefined
        : resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: timeoutMs,
          });
    const operation = buildTimeoutAbortSignal({
      timeoutMs: remaining(),
      signal: options?.signal,
      operation: "clawrouter.ollama",
    });
    try {
      operation.signal?.throwIfAborted();
      const apiKey = options?.apiKey?.trim();
      if (!apiKey || isNonSecretApiKeyMarker(apiKey)) {
        throw new Error("ClawRouter Ollama requires the original proxy key");
      }
      if (
        model.provider !== "clawrouter" ||
        model.id !== route.upstreamModel ||
        model.baseUrl !== route.baseUrl
      ) {
        throw new Error("ClawRouter Ollama selected model or destination changed");
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(model.headers ?? {})) {
        if (typeof value === "string") {
          headers[name] = value;
        }
      }
      const nativeStream = await racePromiseWithAbortSignal(
        () =>
          createProviderNativeStreamFn({
            api: "ollama",
            baseUrl: route.baseUrl,
            transport: route.transport,
            headers,
          }),
        operation.signal,
        (signal) => signal.reason,
      );
      operation.signal?.throwIfAborted();
      const requestTimeoutMs = remaining();
      // Match this model's replay identity only at the same upstream wire boundary.
      // The caller's transcript and catalog identity remain unchanged.
      const nativeContext = {
        ...context,
        messages: context.messages.map((message) =>
          message.role === "assistant" &&
          message.provider === "clawrouter" &&
          message.api === "ollama" &&
          message.model === ctx.model.id
            ? { ...message, model: route.upstreamModel }
            : message,
        ),
      };
      const output = await nativeStream(model, nativeContext, {
        ...options,
        apiKey,
        signal: operation.signal,
        ...(requestTimeoutMs === undefined
          ? {}
          : { timeoutMs: requestTimeoutMs, requestTimeoutMs }),
      });
      // Catalog-native terminal results follow guarded response/dispatcher release.
      void output.result().then(operation.cleanup, operation.cleanup);
      return output;
    } catch (error) {
      operation.cleanup();
      throw error;
    }
  };
}
