import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { LLAMA_SERVER_DISCOVERY_TIMEOUT_MS } from "./defaults.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { mapLlamaServerModel } from "./models.js";

export type LlamaServerDiscoveryResult = Awaited<ReturnType<typeof discoverLlamaServer>>;

/** Discovers llama-server models without loading, waking, or unloading them. */
export async function discoverLlamaServer(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
  signal?: AbortSignal;
  useRuntimeDefaults?: boolean;
}) {
  const endpoint = resolveLlamaServerEndpoint(params.baseUrl);
  const result = await discoverOpenAICompatibleLocalModels({
    baseUrl: endpoint.inferenceBaseUrl,
    serverBaseUrl: endpoint.origin,
    allowPrivateNetwork: params.allowPrivateNetwork,
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
