import type { RuntimeVersionEnv } from "../version.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { normalizeProviderId } from "./provider-id.js";

export type ProviderAttributionVerification =
  | "vendor-documented"
  | "vendor-hidden-api-spec"
  | "vendor-sdk-hook-only"
  | "internal-runtime";

export type ProviderAttributionHook =
  | "request-headers"
  | "default-headers"
  | "user-agent-extra"
  | "custom-user-agent";

export type ProviderAttributionPolicy = {
  provider: string;
  enabledByDefault: boolean;
  verification: ProviderAttributionVerification;
  hook?: ProviderAttributionHook;
  docsUrl?: string;
  reviewNote?: string;
  product: string;
  version: string;
  headers?: Record<string, string>;
};

export type ProviderAttributionIdentity = Pick<ProviderAttributionPolicy, "product" | "version">;

export type ProviderRequestTransport = "stream" | "websocket" | "http" | "media-understanding";
export type ProviderRequestCapability = "llm" | "audio" | "image" | "video" | "other";

export type ProviderEndpointClass =
  | "default"
  | "openai-public"
  | "openai-codex"
  | "azure-openai"
  | "openrouter"
  | "local"
  | "custom"
  | "invalid";

export type ProviderRequestPolicyInput = {
  provider?: string | null;
  api?: string | null;
  baseUrl?: string | null;
  transport?: ProviderRequestTransport;
  capability?: ProviderRequestCapability;
};

export type ProviderRequestPolicyResolution = {
  provider?: string;
  policy?: ProviderAttributionPolicy;
  endpointClass: ProviderEndpointClass;
  usesConfiguredBaseUrl: boolean;
  knownProviderFamily: string;
  attributionProvider?: string;
  attributionHeaders?: Record<string, string>;
  allowsHiddenAttribution: boolean;
  usesKnownNativeOpenAIEndpoint: boolean;
  usesKnownNativeOpenAIRoute: boolean;
  usesVerifiedOpenAIAttributionHost: boolean;
  usesExplicitProxyLikeEndpoint: boolean;
};

const OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw";
const OPENCLAW_ATTRIBUTION_ORIGINATOR = "openclaw";

const LOCAL_ENDPOINT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function formatOpenClawUserAgent(version: string): string {
  return `${OPENCLAW_ATTRIBUTION_ORIGINATOR}/${version}`;
}

function resolveUrlHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    const normalized = value.trim().toLowerCase();
    if (normalized.includes("api.openai.com")) {
      return "api.openai.com";
    }
    if (normalized.includes("chatgpt.com")) {
      return "chatgpt.com";
    }
    if (normalized.includes(".openai.azure.com")) {
      const suffixStart = normalized.indexOf(".openai.azure.com");
      const prefix = normalized.slice(0, suffixStart).replace(/^https?:\/\//, "");
      return `${prefix}.openai.azure.com`;
    }
    if (normalized.includes("openrouter.ai")) {
      return "openrouter.ai";
    }
    if (
      normalized.includes("localhost") ||
      normalized.includes("127.0.0.1") ||
      normalized.includes("[::1]") ||
      normalized.includes("://::1")
    ) {
      return "localhost";
    }
    return undefined;
  }
}

function isLocalEndpointHost(host: string): boolean {
  return (
    LOCAL_ENDPOINT_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

function classifyProviderEndpoint(baseUrl: string | null | undefined): ProviderEndpointClass {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return "default";
  }

  const host = resolveUrlHostname(baseUrl);
  if (!host) {
    return "invalid";
  }
  if (host === "api.openai.com") {
    return "openai-public";
  }
  if (host === "chatgpt.com") {
    return "openai-codex";
  }
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return "openrouter";
  }
  if (host.endsWith(".openai.azure.com")) {
    return "azure-openai";
  }
  if (isLocalEndpointHost(host)) {
    return "local";
  }
  return "custom";
}

function resolveKnownProviderFamily(provider: string | undefined): string {
  switch (provider) {
    case "openai":
    case "openai-codex":
    case "azure-openai":
    case "azure-openai-responses":
      return "openai-family";
    case "openrouter":
      return "openrouter";
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "github-copilot":
      return "github-copilot";
    case "groq":
      return "groq";
    case "mistral":
      return "mistral";
    case "together":
      return "together";
    default:
      return provider || "unknown";
  }
}

export function resolveProviderAttributionIdentity(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionIdentity {
  return {
    product: OPENCLAW_ATTRIBUTION_PRODUCT,
    version: resolveRuntimeServiceVersion(env),
  };
}

function buildOpenRouterAttributionPolicy(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  const identity = resolveProviderAttributionIdentity(env);
  return {
    provider: "openrouter",
    enabledByDefault: true,
    verification: "vendor-documented",
    hook: "request-headers",
    docsUrl: "https://openrouter.ai/docs/app-attribution",
    reviewNote: "Documented app attribution headers. Verified in OpenClaw runtime wrapper.",
    ...identity,
    headers: {
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": identity.product,
      "X-OpenRouter-Categories": "cli-agent",
    },
  };
}

function buildOpenAIAttributionPolicy(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  const identity = resolveProviderAttributionIdentity(env);
  return {
    provider: "openai",
    enabledByDefault: true,
    verification: "vendor-hidden-api-spec",
    hook: "request-headers",
    reviewNote:
      "OpenAI native traffic supports hidden originator/User-Agent attribution. Verified against the Codex wire contract.",
    ...identity,
    headers: {
      originator: OPENCLAW_ATTRIBUTION_ORIGINATOR,
      version: identity.version,
      "User-Agent": formatOpenClawUserAgent(identity.version),
    },
  };
}

function buildOpenAICodexAttributionPolicy(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  const identity = resolveProviderAttributionIdentity(env);
  return {
    provider: "openai-codex",
    enabledByDefault: true,
    verification: "vendor-hidden-api-spec",
    hook: "request-headers",
    reviewNote:
      "OpenAI Codex ChatGPT-backed traffic supports the same hidden originator/User-Agent attribution contract.",
    ...identity,
    headers: {
      originator: OPENCLAW_ATTRIBUTION_ORIGINATOR,
      version: identity.version,
      "User-Agent": formatOpenClawUserAgent(identity.version),
    },
  };
}

function buildSdkHookOnlyPolicy(
  provider: string,
  hook: ProviderAttributionHook,
  reviewNote: string,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  return {
    provider,
    enabledByDefault: false,
    verification: "vendor-sdk-hook-only",
    hook,
    reviewNote,
    ...resolveProviderAttributionIdentity(env),
  };
}

export function listProviderAttributionPolicies(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy[] {
  return [
    buildOpenRouterAttributionPolicy(env),
    buildOpenAIAttributionPolicy(env),
    buildOpenAICodexAttributionPolicy(env),
    buildSdkHookOnlyPolicy(
      "anthropic",
      "default-headers",
      "Anthropic JS SDK exposes defaultHeaders, but app attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "google",
      "user-agent-extra",
      "Google GenAI JS SDK exposes userAgentExtra/httpOptions, but provider-side attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "groq",
      "default-headers",
      "Groq JS SDK exposes defaultHeaders, but app attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "mistral",
      "custom-user-agent",
      "Mistral JS SDK exposes a custom userAgent option, but app attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "together",
      "default-headers",
      "Together JS SDK exposes defaultHeaders, but app attribution is not yet verified.",
      env,
    ),
  ];
}

export function resolveProviderAttributionPolicy(
  provider?: string | null,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy | undefined {
  const normalized = normalizeProviderId(provider ?? "");
  return listProviderAttributionPolicies(env).find((policy) => policy.provider === normalized);
}

export function resolveProviderAttributionHeaders(
  provider?: string | null,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): Record<string, string> | undefined {
  const policy = resolveProviderAttributionPolicy(provider, env);
  if (!policy?.enabledByDefault) {
    return undefined;
  }
  return policy.headers;
}

export function resolveProviderRequestPolicy(
  input: ProviderRequestPolicyInput,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderRequestPolicyResolution {
  const provider = normalizeProviderId(input.provider ?? "");
  const policy = resolveProviderAttributionPolicy(provider, env);
  const endpointClass = classifyProviderEndpoint(input.baseUrl);
  const api = input.api?.trim().toLowerCase();
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai-codex" ||
    endpointClass === "azure-openai";
  const usesOpenAIPublicAttributionHost = endpointClass === "openai-public";
  const usesOpenAICodexAttributionHost = endpointClass === "openai-codex";
  const usesVerifiedOpenAIAttributionHost =
    usesOpenAIPublicAttributionHost || usesOpenAICodexAttributionHost;
  const usesExplicitProxyLikeEndpoint = usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint;

  let attributionProvider: string | undefined;
  if (
    provider === "openai" &&
    (api === "openai-completions" ||
      api === "openai-responses" ||
      (input.capability === "audio" && api === "openai-audio-transcriptions")) &&
    usesOpenAIPublicAttributionHost
  ) {
    attributionProvider = "openai";
  } else if (
    provider === "openai-codex" &&
    (api === "openai-codex-responses" || api === "openai-responses") &&
    usesOpenAICodexAttributionHost
  ) {
    attributionProvider = "openai-codex";
  } else if (provider === "openrouter" && policy?.enabledByDefault) {
    // OpenRouter attribution is documented and intentionally remains
    // provider-key-gated for this pass, including custom base URLs configured
    // under the openrouter provider. The endpoint class is still surfaced so a
    // later host-gating decision can reuse the same classifier without changing
    // callers again.
    attributionProvider = "openrouter";
  }

  const attributionHeaders = attributionProvider
    ? resolveProviderAttributionHeaders(attributionProvider, env)
    : undefined;

  return {
    provider: provider || undefined,
    policy,
    endpointClass,
    usesConfiguredBaseUrl,
    knownProviderFamily: resolveKnownProviderFamily(provider || undefined),
    attributionProvider,
    attributionHeaders,
    allowsHiddenAttribution:
      attributionProvider !== undefined && policy?.verification === "vendor-hidden-api-spec",
    usesKnownNativeOpenAIEndpoint,
    usesKnownNativeOpenAIRoute:
      endpointClass === "default" ? provider === "openai" : usesKnownNativeOpenAIEndpoint,
    usesVerifiedOpenAIAttributionHost,
    usesExplicitProxyLikeEndpoint,
  };
}

export function resolveProviderRequestAttributionHeaders(
  input: ProviderRequestPolicyInput,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): Record<string, string> | undefined {
  return resolveProviderRequestPolicy(input, env).attributionHeaders;
}
