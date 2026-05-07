import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_API_HOST = "api.openai.com";

export function isOpenAIProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === OPENAI_PROVIDER_ID;
}

export function isOfficialOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return (
    parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === OPENAI_API_HOST &&
    (pathname === "" || pathname === "/v1") &&
    parsed.search === "" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

export function openAIProviderUsesOfficialTransport(params: { config?: OpenClawConfig }): boolean {
  const providerConfig = findNormalizedProviderValue(params.config?.models?.providers, "openai");
  if (!providerConfig) {
    return true;
  }
  if (providerConfig.api === OPENAI_CODEX_RESPONSES_API) {
    return true;
  }
  return isOfficialOpenAIBaseUrl(providerConfig.baseUrl);
}

export function openAIRouteRequiresCodexRuntime(params: {
  provider?: string;
  config?: OpenClawConfig;
}): boolean {
  return isOpenAIProvider(params.provider) && openAIProviderUsesOfficialTransport(params);
}

export function hasOpenAICodexAuthProfileOverride(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("openai-codex:");
}

export function modelRefUsesOpenAIProvider(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return slashIndex > 0 && isOpenAIProvider(trimmed.slice(0, slashIndex));
}
