import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { LLAMA_SERVER_DISCOVERY_TIMEOUT_MS } from "./defaults.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { mapLlamaServerModel, type LlamaServerDiscoveredModel } from "./models.js";

export type LlamaServerDiscoveryResult =
  | {
      kind: "success";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      models: LlamaServerDiscoveredModel[];
    }
  | {
      kind: "unreachable";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      error: unknown;
    }
  | {
      kind: "http-error";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      status: number;
      path: string;
    }
  | {
      kind: "invalid-response";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      path: string;
      error: unknown;
    };

/** Discovers llama-server models without loading, waking, or unloading them. */
export async function discoverLlamaServer(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  useRuntimeDefaults?: boolean;
}): Promise<LlamaServerDiscoveryResult> {
  const endpoint = resolveLlamaServerEndpoint(params.baseUrl);
  const result = await discoverOpenAICompatibleLocalModels({
    baseUrl: endpoint.inferenceBaseUrl,
    serverBaseUrl: endpoint.origin,
    apiKey: params.apiKey,
    headers: params.headers,
    label: "llama-server",
    healthPath: "/health",
    modelsPathOrder: "server-first",
    routerModelProps: true,
    timeoutMs: LLAMA_SERVER_DISCOVERY_TIMEOUT_MS,
    signal: params.signal,
    rawResult: true,
  });
  if (result.kind !== "success") {
    return { ...result, endpoint };
  }
  return {
    kind: "success" as const,
    endpoint,
    models: result.rows.flatMap(({ model, props }) => {
      const mapped = mapLlamaServerModel(model, props, params.useRuntimeDefaults);
      return mapped ? [mapped] : [];
    }),
  };
}
