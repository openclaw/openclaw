import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import {
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { hasLlamaServerAuthorizationHeader } from "./auth-policy.js";
import { resolveLlamaServerProviderHeaders, resolveLlamaServerRuntimeApiKey } from "./auth.js";
import { LLAMA_CPP_SERVER, type LlamaServerIdentity } from "./defaults.js";
import { discoverLlamaServer } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig } from "./models.js";

export async function discoverLlamaServerProvider(
  ctx: ProviderCatalogContext,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<ProviderCatalogResult> {
  const configured = ctx.config.models?.providers?.[server.id];
  const auth = ctx.resolveProviderApiKey(server.id);
  const headers = await resolveLlamaServerProviderHeaders({
    server,
    config: ctx.config,
    env: ctx.env,
    headers: configured?.headers,
  });
  const authApiKey = auth.discoveryApiKey ?? auth.apiKey;
  const apiKey =
    hasLlamaServerAuthorizationHeader(headers) ||
    (authApiKey && isNonSecretApiKeyMarker(authApiKey))
      ? undefined
      : authApiKey;
  return await runLiveProviderCatalog({
    providerId: server.id,
    profileId: apiKey ? auth.profileId : undefined,
    run: async () => {
      const discovery = await discoverLlamaServer({
        server,
        signal: ctx.signal,
        useRuntimeDefaults: false,
        baseUrl: configured?.baseUrl,
        apiKey,
        headers,
        allowPrivateNetwork: configured?.request?.allowPrivateNetwork,
      });
      if (discovery.kind !== "success") {
        if (!configured && !apiKey && !headers) {
          return null;
        }
        throw discovery.kind === "http-error"
          ? new LiveModelCatalogHttpError(server.id, discovery.status)
          : discovery.error;
      }
      return {
        provider: buildLlamaServerProviderConfig({
          server,
          configured,
          discoveredModels: discovery.models,
        }),
      };
    },
  });
}

export async function prepareLlamaServerDynamicModel(
  ctx: ProviderPrepareDynamicModelContext,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<ProviderRuntimeModel | undefined> {
  const apiKey = await resolveLlamaServerRuntimeApiKey({
    server,
    config: ctx.config,
    agentDir: ctx.agentDir,
    profileId: ctx.authProfileId,
  });
  const headers = await resolveLlamaServerProviderHeaders({
    server,
    config: ctx.config,
    env: process.env,
    headers: ctx.providerConfig?.headers,
  });
  const discovery = await discoverLlamaServer({
    server,
    baseUrl: ctx.providerConfig?.baseUrl,
    apiKey: hasLlamaServerAuthorizationHeader(headers) ? undefined : apiKey,
    headers,
    allowPrivateNetwork: ctx.providerConfig?.request?.allowPrivateNetwork,
  });
  const model =
    discovery.kind === "success"
      ? discovery.models.find((entry) => entry.config.id === ctx.modelId)
      : undefined;
  if (!model) {
    return undefined;
  }
  return {
    ...model.config,
    provider: server.id,
    api: ctx.providerConfig?.api ?? "openai-completions",
    baseUrl: resolveLlamaServerEndpoint(ctx.providerConfig?.baseUrl, server).inferenceBaseUrl,
  };
}
