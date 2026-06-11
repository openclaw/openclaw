import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeEmbeddedAgentRuntime } from "./pi-embedded-runner/runtime.js";
import { normalizeProviderId } from "./provider-id.js";

export const OPENAI_PROVIDER_ID = "openai";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

function isOfficialOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.openai.com" &&
      (url.pathname === "" ||
        url.pathname === "/" ||
        url.pathname === "/v1" ||
        url.pathname === "/v1/")
    );
  } catch {
    return false;
  }
}

function openAIProviderUsesCustomBaseUrl(config: OpenClawConfig | undefined): boolean {
  return !isOfficialOpenAIBaseUrl(config?.models?.providers?.openai?.baseUrl);
}

export function isOpenAIProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === OPENAI_PROVIDER_ID;
}

export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === OPENAI_CODEX_PROVIDER_ID;
}

export function openAIProviderUsesCodexRuntimeByDefault(params: {
  provider?: string;
  config?: OpenClawConfig;
}): boolean {
  return isOpenAIProvider(params.provider) && !openAIProviderUsesCustomBaseUrl(params.config);
}

export function parseModelRefProvider(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const slashIndex = value.trim().indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return normalizeProviderId(value.trim().slice(0, slashIndex));
}

export function modelRefUsesOpenAIProvider(value: unknown): boolean {
  return parseModelRefProvider(value) === OPENAI_PROVIDER_ID;
}

export function modelSelectionShouldEnsureCodexPlugin(params: {
  model?: string;
  config?: OpenClawConfig;
}): boolean {
  const provider = parseModelRefProvider(params.model);
  if (provider === OPENAI_CODEX_PROVIDER_ID) {
    return true;
  }
  return provider === OPENAI_PROVIDER_ID && !openAIProviderUsesCustomBaseUrl(params.config);
}

export function hasOpenAICodexAuthProfileOverride(value: unknown): boolean {
  return (
    typeof value === "string" &&
    normalizeOptionalLowercaseString(value)?.startsWith(`${OPENAI_CODEX_PROVIDER_ID}:`) === true
  );
}

export function resolveContextConfigProviderForRuntime(params: {
  provider: string;
  runtimeId?: string;
}): string {
  const provider = normalizeProviderId(params.provider);
  const runtimeId = normalizeEmbeddedAgentRuntime(params.runtimeId);
  if (provider === OPENAI_PROVIDER_ID && runtimeId === "codex") {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  return params.provider;
}
