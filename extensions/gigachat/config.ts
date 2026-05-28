import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";

export const GIGACHAT_PROVIDER_ID = "gigachat";
export const GIGACHAT_MAIN_BASE_URL = "https://gigachat.devices.sberbank.ru/api/v1";
export const GIGACHAT_BUSINESS_BASE_URL = "https://api.giga.chat/v1";
export const GIGACHAT_OAUTH_BASE_URL = "https://ngw.devices.sberbank.ru:9443/api/v2";
export const GIGACHAT_DEFAULT_MODEL_ID = "GigaChat-2";

export const GIGACHAT_SCOPE_VALUES = [
  "GIGACHAT_API_PERS",
  "GIGACHAT_API_B2B",
  "GIGACHAT_API_CORP",
] as const;

export type GigachatScope = (typeof GIGACHAT_SCOPE_VALUES)[number];
export type GigachatEndpoint = "main" | "business";

export type GigachatPluginConfig = {
  scope: GigachatScope;
  endpoint: GigachatEndpoint;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeGigachatScope(value: unknown): GigachatScope {
  const normalized = normalizeOptionalString(value);
  return GIGACHAT_SCOPE_VALUES.includes(normalized as GigachatScope)
    ? (normalized as GigachatScope)
    : "GIGACHAT_API_PERS";
}

export function normalizeGigachatEndpoint(value: unknown): GigachatEndpoint {
  return normalizeOptionalString(value) === "business" ? "business" : "main";
}

export function resolveGigachatPluginConfig(
  config: OpenClawConfig | undefined,
): GigachatPluginConfig {
  const pluginConfig = resolvePluginConfigObject(config, GIGACHAT_PROVIDER_ID);
  return {
    scope: normalizeGigachatScope(pluginConfig?.scope),
    endpoint: normalizeGigachatEndpoint(pluginConfig?.endpoint),
  };
}

export function resolveGigachatChatBaseUrl(config: OpenClawConfig | undefined): string {
  return resolveGigachatPluginConfig(config).endpoint === "business"
    ? GIGACHAT_BUSINESS_BASE_URL
    : GIGACHAT_MAIN_BASE_URL;
}
