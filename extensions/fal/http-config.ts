import type { AuthProfileStore, OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveProviderHttpRequestConfig,
  type ProviderRequestCapability,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_FAL_BASE_URL = "https://fal.run";

type FalAuthenticatedRequest = {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
};

export async function resolveFalHttpRequestConfig(params: {
  req: FalAuthenticatedRequest;
  capability: ProviderRequestCapability;
}): Promise<ReturnType<typeof resolveProviderHttpRequestConfig>> {
  const auth = await resolveApiKeyForProvider({
    provider: "fal",
    cfg: params.req.cfg,
    agentDir: params.req.agentDir,
    store: params.req.authStore,
  });
  if (!auth.apiKey) {
    throw new Error("fal API key missing");
  }

  return resolveProviderHttpRequestConfig({
    baseUrl: normalizeOptionalString(params.req.cfg?.models?.providers?.fal?.baseUrl),
    defaultBaseUrl: DEFAULT_FAL_BASE_URL,
    // Configured relay URLs retain the same strict SSRF policy as public fal endpoints.
    allowPrivateNetwork: false,
    defaultHeaders: {
      Authorization: `Key ${auth.apiKey}`,
      "Content-Type": "application/json",
    },
    provider: "fal",
    capability: params.capability,
    transport: "http",
  });
}
