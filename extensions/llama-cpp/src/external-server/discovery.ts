import os from "node:os";
import path from "node:path";
import { buildOpenAICompatibleLiveModels } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import {
  LLAMA_CPP_SERVER,
  LLAMA_SERVER_DISCOVERY_TIMEOUT_MS,
  type LlamaServerIdentity,
} from "./defaults.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { mapLlamaServerModel } from "./models.js";

export type LlamaServerDiscoveryResult = Awaited<ReturnType<typeof discoverLlamaServer>>;

/** Discovers llama-server models without loading, waking, or unloading them. */
export async function discoverLlamaServer(params: {
  server?: LlamaServerIdentity;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
  signal?: AbortSignal;
  useRuntimeDefaults?: boolean;
  requireAppListener?: boolean;
}) {
  const endpoint = resolveLlamaServerEndpoint(params.baseUrl, params.server ?? LLAMA_CPP_SERVER);
  const preset =
    process.platform === "win32"
      ? path.join(os.homedir(), ".llama", "model-context-presets.ini")
      : path.join(os.homedir(), "Library", "Application Support", "Llama", "models.ini");
  const result = await discoverOpenAICompatibleLocalModels({
    ...(params.requireAppListener
      ? { localListenerArgument: { flag: "--models-preset", value: preset } }
      : {}),
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
  // Older hosts can still connect explicitly, but cannot identify a desktop app by port alone.
  if (params.requireAppListener && result.matchedLocalListener !== true) {
    return {
      kind: "unreachable" as const,
      endpoint,
      error: new Error("Llama app listener was not identified"),
    };
  }
  // Keep the catalog owner's chat eligibility alongside llama-server's runtime limits.
  const catalog = buildOpenAICompatibleLiveModels(
    result.rows.map(({ model }) => model),
    { baseUrl: endpoint.inferenceBaseUrl, models: [] },
  );
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  return {
    kind: "success" as const,
    endpoint,
    models: result.rows.flatMap(({ model, props }) => {
      const mapped = mapLlamaServerModel(model, props, params.useRuntimeDefaults);
      const entry = mapped && catalogById.get(mapped.config.id);
      if (!mapped || !entry) {
        return [];
      }
      if (entry.inference) {
        mapped.config.inference = entry.inference;
      }
      return [mapped];
    }),
  };
}
