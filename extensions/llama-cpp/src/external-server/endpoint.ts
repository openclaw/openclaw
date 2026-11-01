import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_CPP_SERVER, type LlamaServerIdentity } from "./defaults.js";

/** Resolves the server origin and its OpenAI-compatible `/v1` inference base. */
export function resolveLlamaServerEndpoint(
  configuredBaseUrl?: string,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
) {
  const configured = configuredBaseUrl?.trim() || server.defaultOrigin;
  const parsed = new URL(
    /^[a-z][a-z\d+.-]*:\/\//iu.test(configured) ? configured : `http://${configured}`,
  );
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`Unsupported llama-server protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("llama-server base URL must not contain credentials");
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\/v1$/iu, "");
  parsed.pathname = pathname || "/";
  parsed.search = "";
  parsed.hash = "";
  const origin = parsed.toString().replace(/\/$/u, "");
  return {
    origin,
    inferenceBaseUrl: `${origin}/v1`,
  };
}

/** Canonicalizes persisted provider config for the shared OpenAI transport. */
export function normalizeLlamaServerProviderConfig(
  provider: ModelProviderConfig,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): ModelProviderConfig {
  const endpoint = resolveLlamaServerEndpoint(provider.baseUrl, server);
  const request = provider.request ?? {};
  const normalizedRequest =
    typeof request.allowPrivateNetwork === "boolean"
      ? request
      : { ...request, allowPrivateNetwork: true };
  return {
    ...provider,
    baseUrl: endpoint.inferenceBaseUrl,
    api: "openai-completions",
    request: normalizedRequest,
  };
}
