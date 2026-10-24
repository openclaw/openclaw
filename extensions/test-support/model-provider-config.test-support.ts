import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export function createModelProviderConfig<T extends Record<string, ModelProviderConfig>>(
  providers: T,
) {
  return { models: { providers } };
}

export function createProxyRequestModelProviderConfig(providerId: string) {
  return createModelProviderConfig({
    [providerId]: {
      baseUrl: "https://relay.example.test",
      models: [],
      request: {
        headers: { "X-Relay": "synthetic-route" },
        proxy: { mode: "explicit-proxy", url: "http://proxy.example:8080" },
        allowPrivateNetwork: true,
      },
    },
  });
}
