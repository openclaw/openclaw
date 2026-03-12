import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";

export type PersonalAssistantPluginConfig = {
  assistantApiBaseUrl?: string;
  assistantApiToken?: string;
  requestTimeoutMs?: number;
};

export function readPluginConfig(api: OpenClawPluginApi): PersonalAssistantPluginConfig {
  const config = (api.pluginConfig ?? {}) as PersonalAssistantPluginConfig;

  return {
    assistantApiBaseUrl: normalizeText(config.assistantApiBaseUrl),
    assistantApiToken: normalizeText(config.assistantApiToken),
    requestTimeoutMs:
      typeof config.requestTimeoutMs === "number" && config.requestTimeoutMs >= 1_000
        ? config.requestTimeoutMs
        : undefined,
  };
}

export function normalizeText(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, "");
}

export function resolveTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}
