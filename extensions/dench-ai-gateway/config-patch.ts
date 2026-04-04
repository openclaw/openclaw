import {
  buildDenchCloudAgentModelEntries,
  buildDenchCloudProviderModels,
  buildDenchGatewayApiBaseUrl,
  type DenchCloudCatalogModel,
} from "./models.js";

export type DenchCloudProviderConfig = {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions" | "openai-responses";
  models: ReturnType<typeof buildDenchCloudProviderModels>;
};

export type ComposioMcpServerConfig = {
  url: string;
  transport: "streamable-http";
  headers: {
    Authorization: string;
  };
};

export function buildComposioMcpServerConfig(
  gatewayUrl: string,
  apiKey: string,
): ComposioMcpServerConfig {
  return {
    url: `${gatewayUrl}/v1/composio/mcp`,
    transport: "streamable-http",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

export function buildDenchCloudProviderConfig(params: {
  gatewayUrl: string;
  apiKey: string;
  models: DenchCloudCatalogModel[];
}): DenchCloudProviderConfig {
  return {
    baseUrl: buildDenchGatewayApiBaseUrl(params.gatewayUrl),
    apiKey: params.apiKey,
    api: "openai-responses",
    models: buildDenchCloudProviderModels(params.models),
  };
}

export function buildDenchCloudConfigPatch(params: {
  gatewayUrl: string;
  apiKey: string;
  models: DenchCloudCatalogModel[];
}) {
  return {
    models: {
      mode: "merge" as const,
      providers: {
        "dench-cloud": buildDenchCloudProviderConfig(params),
      },
    },
    agents: {
      defaults: {
        models: buildDenchCloudAgentModelEntries(params.models),
      },
    },
    messages: {
      tts: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            baseUrl: params.gatewayUrl,
            apiKey: params.apiKey,
          },
        },
      },
    },
    mcp: {
      servers: {
        composio: buildComposioMcpServerConfig(params.gatewayUrl, params.apiKey),
      },
    },
  };
}
