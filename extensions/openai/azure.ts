import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

// Matches the Azure host set recognized elsewhere in the provider
// (see `isAzureOpenAICompatibleHost` in `src/agents/openai-transport-stream.ts`).
// Duplicated here because extensions cannot import from `src/` under the
// `lint:extensions:no-src-outside-plugin-sdk` boundary check.
const AZURE_OPENAI_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
] as const;

// Matches the default used by chat / Responses in
// `src/agents/openai-transport-stream.ts` (`DEFAULT_AZURE_OPENAI_API_VERSION`).
// Kept in sync manually; see that file for the canonical value.
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";

export function isAzureOpenAIBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const host = normalizeLowercaseStringOrEmpty(new URL(trimmed).hostname);
    return AZURE_OPENAI_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

export function resolveAzureOpenAIApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

export type AzureOpenAIImageRoute = {
  url: string;
  headers: Record<string, string>;
};

// Pathname segments that onboarding/clients commonly append to an Azure endpoint
// (e.g. OpenClaw onboarding stores `https://<endpoint>/openai/v1`). We must strip
// these before appending our own `/openai/deployments/...` path, otherwise the
// resulting URL duplicates the `/openai` segment and returns 404.
const AZURE_BASE_URL_PATHNAME_STRIP_PATTERN = /\/openai(?:\/v\d+)?\/?$/i;

/**
 * Builds an Azure OpenAI image-route URL + auth header override.
 *
 * Azure's shape is `{endpoint}/openai/deployments/{deployment}/images/{op}?api-version=...`
 * with the key passed as `api-key:` (public OpenAI uses `Authorization: Bearer`).
 * The deployment name comes from `model` — this mirrors the chat path's
 * `resolveAzureDeploymentName` convention where deployment names are routed via `model`.
 *
 * The incoming `baseUrl` may carry an OpenAI-style suffix (e.g. `/openai/v1`) from
 * standard onboarding; we normalize it down to the endpoint origin + surviving
 * path prefix before appending the deployment-scoped route. Any query/fragment
 * on the base URL is intentionally dropped — `api-version` is the only query
 * parameter Azure expects here.
 */
export function buildAzureOpenAIImageRoute(params: {
  baseUrl: string;
  deployment: string;
  apiKey: string;
  operation: "generations" | "edits";
  apiVersion?: string;
}): AzureOpenAIImageRoute {
  const apiVersion = params.apiVersion?.trim() || resolveAzureOpenAIApiVersion();
  const deployment = encodeURIComponent(params.deployment);
  const endpoint = normalizeAzureBaseUrlForImageRoute(params.baseUrl);
  return {
    url: `${endpoint}/openai/deployments/${deployment}/images/${params.operation}?api-version=${encodeURIComponent(
      apiVersion,
    )}`,
    headers: {
      "api-key": params.apiKey,
    },
  };
}

/**
 * Reduce an Azure base URL to the form `<origin><surviving-path>` where any
 * trailing `/openai` or `/openai/vN` segment has been removed. Falls back to
 * a simple trailing-slash trim when the URL cannot be parsed.
 */
function normalizeAzureBaseUrlForImageRoute(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
  let pathname = parsed.pathname.replace(AZURE_BASE_URL_PATHNAME_STRIP_PATTERN, "");
  pathname = pathname.replace(/\/+$/, "");
  const origin = `${parsed.protocol}//${parsed.host}`;
  return pathname ? `${origin}${pathname}` : origin;
}
