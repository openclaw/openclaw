import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type ZekeProfile = "sprout" | "rambo" | "external-client";

export type ZekePluginConfig = {
  baseUrl: string;
  tokenEnv: string;
  profile: ZekeProfile;
  operatorId: string;
  operatorSigningKeyEnv: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveZekePluginConfig(
  api: Pick<OpenClawPluginApi, "pluginConfig">,
): ZekePluginConfig {
  const raw = api.pluginConfig ?? {};
  const profile = readString(raw.profile);
  return {
    baseUrl: readString(raw.baseUrl) ?? "http://host.docker.internal:3747",
    tokenEnv: readString(raw.tokenEnv) ?? "ZEKEFLOW_OPENCLAW_TOOL_TOKEN",
    profile:
      profile === "rambo" || profile === "external-client" || profile === "sprout"
        ? profile
        : "sprout",
    operatorId: readString(raw.operatorId) ?? "openclaw:ross",
    operatorSigningKeyEnv:
      readString(raw.operatorSigningKeyEnv) ?? "ZEKEFLOW_OPENCLAW_OPERATOR_SIGNING_KEY",
  };
}

export function resolveAuthorityToken(config: ZekePluginConfig, env = process.env): string {
  const primary = env[config.tokenEnv];
  if (primary && primary.trim()) return primary.trim();
  return "";
}

export function resolveOperatorSigningKey(config: ZekePluginConfig, env = process.env): string {
  const key = env[config.operatorSigningKeyEnv];
  return key && key.trim() ? key.trim() : "";
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}
