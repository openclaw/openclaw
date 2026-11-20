import { getAiTransportHost } from "../host.js";
import type { Model } from "../types.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";

export type OpenAIResponsesWebSocketMode = "websocket" | "websocket-cached" | "auto";

export function resolveNativeOpenAIResponsesWebSocketMode(
  model: Model,
  transport: OpenAIResponsesOptions["transport"],
): OpenAIResponsesWebSocketMode | undefined {
  if (transport !== "websocket" && transport !== "websocket-cached" && transport !== "auto") {
    return undefined;
  }
  if (getAiTransportHost().requiresManagedTransport(model, "fetch")) {
    return undefined;
  }
  return supportsNativeOpenAIResponsesEndpoint(model) ? transport : undefined;
}

export function combineWebSocketTimeoutSignal(
  signal: AbortSignal,
  model: Model,
  timeoutMs: number | undefined,
) {
  const resolvedTimeoutMs =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getAiTransportHost().resolveModelRequestTimeoutMs(model);
  if (resolvedTimeoutMs === undefined || !Number.isFinite(resolvedTimeoutMs)) {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, resolvedTimeoutMs))]);
}
