import type { Model } from "@openclaw/llm-core";
import {
  getAiTransportHost,
  type AiProviderRequestPolicyInput,
  type AiTransportHost,
} from "../host.js";

export function buildGuardedModelFetch(
  model: Model,
  timeoutMs?: number,
  options?: { sanitizeSse?: boolean; onSseComment?: () => void },
): typeof fetch {
  const host = getAiTransportHost();
  if (options !== undefined) {
    return host.buildModelFetch(model, timeoutMs, options) ?? globalThis.fetch;
  }
  if (timeoutMs !== undefined) {
    return host.buildModelFetch(model, timeoutMs) ?? globalThis.fetch;
  }
  return host.buildModelFetch(model) ?? globalThis.fetch;
}

/** SDKs keep their default transport unless their embedding owner requires an explicit one. */
export function buildManagedModelFetch(
  model: Model,
  host: AiTransportHost = getAiTransportHost(),
): typeof fetch | undefined {
  if (!host.requiresManagedTransport(model)) {
    return undefined;
  }
  const fetcher = host.buildModelFetch(model);
  if (!fetcher) {
    throw new Error("The embedding host requires a managed provider transport");
  }
  return fetcher;
}

export function resolveProviderEndpoint(model: { baseUrl?: string }): { endpointClass: string } {
  return {
    endpointClass: getAiTransportHost().resolveProviderRequestCapabilities({
      baseUrl: model.baseUrl,
      model,
    }).endpointClass,
  };
}

export function resolveProviderRequestCapabilities(
  input: AiProviderRequestPolicyInput,
  model?: object,
) {
  return getAiTransportHost().resolveProviderRequestCapabilities({ ...input, model });
}

export function resolveModelRequestTimeoutMs(model: Model, timeoutMs?: number): number | undefined {
  return timeoutMs ?? getAiTransportHost().resolveModelRequestTimeoutMs(model);
}
