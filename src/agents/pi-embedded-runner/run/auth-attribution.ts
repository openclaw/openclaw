import type { PluginHookLlmCallAuthInfo } from "../../../plugins/types.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { normalizeProviderId } from "../../model-selection.js";

type ResolvedAuthSnapshot = Pick<ResolvedProviderAuth, "mode" | "profileId" | "source">;

const LOCAL_NO_AUTH_PROVIDERS = new Set(["ollama"]);

const normalizeProfileType = (mode: ResolvedProviderAuth["mode"]): string => {
  switch (mode) {
    case "api-key":
      return "api_key";
    case "aws-sdk":
      return "aws_sdk";
    default:
      return mode;
  }
};

const parseProfileIdFromSource = (source: string): string | undefined => {
  if (!source.startsWith("profile:")) {
    return undefined;
  }
  const value = source.slice("profile:".length).trim();
  return value.length > 0 ? value : undefined;
};

const normalizeSource = (sourceRaw: string): PluginHookLlmCallAuthInfo["source"] => {
  const source = sourceRaw.trim();
  if (source.length === 0) {
    return "unknown";
  }
  if (source.startsWith("profile:")) {
    return "auth_profile";
  }
  if (source.startsWith("env:") || source.startsWith("shell env:") || source === "gcloud adc") {
    return "env";
  }
  if (source === "models.json" || source.startsWith("inline:")) {
    return "inline";
  }
  if (source.includes("aws-sdk")) {
    return "unknown";
  }
  return "unknown";
};

export function resolveLlmCallAuthInfo(params: {
  provider: string;
  resolvedAuth?: ResolvedAuthSnapshot | null;
}): PluginHookLlmCallAuthInfo {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (LOCAL_NO_AUTH_PROVIDERS.has(normalizedProvider)) {
    return { method: "none", source: "none" };
  }

  const resolvedAuth = params.resolvedAuth;
  if (!resolvedAuth) {
    return { method: "unknown", source: "unknown" };
  }

  const mode = resolvedAuth.mode;
  const profileType = normalizeProfileType(mode);
  const source = normalizeSource(resolvedAuth.source);
  const profileIdFromSource = parseProfileIdFromSource(resolvedAuth.source);
  const profileId = resolvedAuth.profileId?.trim() || profileIdFromSource;

  if (mode === "oauth") {
    if (!profileId && source === "unknown") {
      return { method: "unknown", profileType, source };
    }
    return {
      method: "oauth",
      profileId: profileId || undefined,
      profileType,
      source,
    };
  }

  if (mode === "api-key" || mode === "token") {
    if (!profileId && source === "unknown") {
      return { method: "unknown", profileType, source };
    }
    return {
      method: "api_key",
      profileId: profileId || undefined,
      profileType,
      source,
    };
  }

  return {
    method: "unknown",
    profileId: profileId || undefined,
    profileType,
    source,
  };
}
