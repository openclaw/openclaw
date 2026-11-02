import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

type CloudflareAiGatewayCredential =
  | {
      type?: string;
      keyRef?: unknown;
      key?: unknown;
      metadata?: {
        accountId?: unknown;
        gatewayId?: unknown;
      };
    }
  | undefined;

function resolveCloudflareAiGatewayApiKey(cred: CloudflareAiGatewayCredential): string | undefined {
  if (!cred || cred.type !== "api_key") {
    return undefined;
  }

  const keyRef = coerceSecretRef(cred.keyRef);
  const keyRefId = normalizeOptionalString(keyRef?.id);
  if (keyRef && keyRefId) {
    return keyRef.source === "env" ? keyRefId : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
  }
  return normalizeOptionalString(cred.key);
}

/**
 * Returns a provider catalog entry when credentials and Gateway metadata are
 * complete enough to construct an Anthropic-compatible base URL.
 */
export function buildCloudflareAiGatewayCatalogProvider(params: {
  credential: CloudflareAiGatewayCredential;
  envApiKey?: string;
}) {
  const apiKey =
    normalizeOptionalString(params.envApiKey) ??
    resolveCloudflareAiGatewayApiKey(params.credential);
  if (!apiKey) {
    return null;
  }
  const metadata = params.credential?.type === "api_key" ? params.credential.metadata : undefined;
  const accountId = normalizeOptionalString(metadata?.accountId);
  const gatewayId = normalizeOptionalString(metadata?.gatewayId);
  if (!accountId || !gatewayId) {
    return null;
  }
  return {
    baseUrl: resolveCloudflareAiGatewayBaseUrl({ accountId, gatewayId }),
    api: "anthropic-messages" as const,
    apiKey,
    models: [buildCloudflareAiGatewayModelDefinition()],
  };
}
