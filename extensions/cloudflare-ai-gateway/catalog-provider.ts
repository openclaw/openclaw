import {
  coerceSecretRef,
  ensureAuthProfileStore,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

export type CloudflareAiGatewayCredential =
  | ReturnType<typeof ensureAuthProfileStore>["profiles"][string]
  | undefined;

export function resolveCloudflareAiGatewayApiKey(
  cred: CloudflareAiGatewayCredential,
): string | undefined {
  if (!cred || cred.type !== "api_key") {
    return undefined;
  }

  const keyRef = coerceSecretRef(cred.keyRef);
  if (keyRef && keyRef.id.trim()) {
    return keyRef.source === "env"
      ? keyRef.id.trim()
      : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
  }
  return cred.key?.trim() || undefined;
}

export function resolveCloudflareAiGatewayMetadata(cred: CloudflareAiGatewayCredential): {
  accountId?: string;
  gatewayId?: string;
} {
  if (!cred || cred.type !== "api_key") {
    return {};
  }
  return {
    accountId: cred.metadata?.accountId?.trim() || undefined,
    gatewayId: cred.metadata?.gatewayId?.trim() || undefined,
  };
}

export function buildCloudflareAiGatewayCatalogProvider(params: {
  credential: CloudflareAiGatewayCredential;
  envApiKey?: string;
}): ModelProviderConfig | null {
  const apiKey = params.envApiKey?.trim() || resolveCloudflareAiGatewayApiKey(params.credential);
  if (!apiKey) {
    return null;
  }
  const { accountId, gatewayId } = resolveCloudflareAiGatewayMetadata(params.credential);
  if (!accountId || !gatewayId) {
    return null;
  }
  const baseUrl = resolveCloudflareAiGatewayBaseUrl({ accountId, gatewayId });
  if (!baseUrl) {
    return null;
  }
  return {
    baseUrl,
    api: "anthropic-messages",
    apiKey,
    models: [buildCloudflareAiGatewayModelDefinition()],
  };
}
