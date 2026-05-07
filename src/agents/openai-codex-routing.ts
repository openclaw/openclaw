import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeProviderId } from "./provider-id.js";

const OPENAI_PROVIDER_ID = "openai";

export function isOpenAIProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === OPENAI_PROVIDER_ID;
}

export function openAIRouteRequiresCodexRuntime(params: {
  provider?: string;
  config?: OpenClawConfig;
}): boolean {
  return normalizeProviderId(params.provider ?? "") === "openai-codex";
}

export function modelSelectionRequiresCodexRuntime(params: {
  model?: string;
  config?: OpenClawConfig;
}): boolean {
  const model = params.model?.trim();
  if (!model) {
    return false;
  }
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) {
    return false;
  }
  const provider = normalizeProviderId(model.slice(0, slashIndex));
  return openAIRouteRequiresCodexRuntime({ provider, config: params.config });
}

export function modelSelectionShouldEnsureCodexPlugin(params: {
  model?: string;
  config?: OpenClawConfig;
}): boolean {
  const model = params.model?.trim();
  if (!model) {
    return false;
  }
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) {
    return false;
  }
  const provider = normalizeProviderId(model.slice(0, slashIndex));
  return provider === "openai" || provider === "openai-codex";
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
