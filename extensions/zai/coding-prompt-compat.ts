// Zai plugin module implements Coding Plan system-prompt compatibility behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Z.AI Coding Plan endpoints deterministically reject (HTTP 429, code 1305,
 * disguised as "overloaded") any request whose system message contains this
 * exact case-sensitive substring. The literal is a provider-contract match
 * against z.ai's measured server-side filter, not an example string; see
 * https://github.com/openclaw/openclaw/issues/103529 for the measurements.
 */
const ZAI_CODING_BLOCKED_PROMPT_SUBSTRING = "You are a personal assistant running inside OpenClaw";

/**
 * Minimal semantics-preserving rewrite. The filter is an exact substring
 * match, so swapping "inside" for "within" is measured to pass (see the issue
 * above) while keeping the assistant identity line intact.
 */
const ZAI_CODING_PROMPT_REPLACEMENT = "You are a personal assistant running within OpenClaw";

/**
 * Both official Coding Plan base URLs (api.z.ai and open.bigmodel.cn) carry
 * this path segment, and it survives user-configured reverse proxies that
 * preserve the upstream path.
 */
const ZAI_CODING_PATH_MARKER = "/api/coding/";

type ConfiguredProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
type ConfiguredProvider = ConfiguredProviders[string];

export type ZaiCodingSystemPromptContext = {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  systemPrompt: string;
};

/** True when the given base URL routes to a Coding Plan endpoint. */
export function isZaiCodingBaseUrl(baseUrl: unknown): boolean {
  const normalized = normalizeOptionalString(baseUrl);
  if (!normalized) {
    return false;
  }
  try {
    return new URL(normalized).pathname.includes(ZAI_CODING_PATH_MARKER);
  } catch {
    return normalized.includes(ZAI_CODING_PATH_MARKER);
  }
}

// Mirrors core resolveConfiguredProviderConfig: exact key first, then the
// first key that matches after provider-id normalization, so the transform
// sees the same provider entry the transport route was resolved from.
function resolveConfiguredProvider(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ConfiguredProvider | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const exact = providers[provider];
  if (exact) {
    return exact;
  }
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  for (const [key, value] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(key) === normalizedProvider) {
      return value;
    }
  }
  return undefined;
}

// Mirrors core matchesProviderScopedModelId: config model ids may be plain
// ("glm-5.2") or provider-scoped ("zai/glm-5.2").
function matchesConfiguredModelId(candidateId: unknown, provider: string, modelId: string): boolean {
  if (typeof candidateId !== "string") {
    return false;
  }
  if (candidateId === modelId) {
    return true;
  }
  const slashIndex = candidateId.indexOf("/");
  if (slashIndex <= 0) {
    return false;
  }
  return (
    candidateId.slice(slashIndex + 1) === modelId &&
    normalizeLowercaseStringOrEmpty(candidateId.slice(0, slashIndex)) ===
      normalizeLowercaseStringOrEmpty(provider)
  );
}

/**
 * Resolves the base URL the transport will use for this provider/model from
 * config, mirroring core model resolution precedence where a per-model
 * `models[]` entry baseUrl overrides the provider-level baseUrl.
 */
function resolveEffectiveConfiguredBaseUrl(ctx: ZaiCodingSystemPromptContext): string | undefined {
  const providerConfig = resolveConfiguredProvider(ctx.config, ctx.provider);
  if (!providerConfig) {
    return undefined;
  }
  const configuredModel = providerConfig.models?.find((candidate) =>
    matchesConfiguredModelId(candidate?.id, ctx.provider, ctx.modelId),
  );
  return (
    normalizeOptionalString(configuredModel?.baseUrl) ??
    normalizeOptionalString(providerConfig.baseUrl)
  );
}

/**
 * Rewrites the blocked identity line for Coding Plan requests only. Returns
 * undefined to leave the prompt byte-identical for ordinary Z.AI routes and
 * for prompts that do not contain the blocked substring.
 */
export function transformZaiCodingSystemPrompt(
  ctx: ZaiCodingSystemPromptContext,
): string | undefined {
  if (!isZaiCodingBaseUrl(resolveEffectiveConfiguredBaseUrl(ctx))) {
    return undefined;
  }
  if (!ctx.systemPrompt.includes(ZAI_CODING_BLOCKED_PROMPT_SUBSTRING)) {
    return undefined;
  }
  return ctx.systemPrompt
    .split(ZAI_CODING_BLOCKED_PROMPT_SUBSTRING)
    .join(ZAI_CODING_PROMPT_REPLACEMENT);
}
