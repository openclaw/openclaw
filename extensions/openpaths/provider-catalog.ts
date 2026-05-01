import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOpenPathsModelDefinition,
  OPENPATHS_BASE_URL,
  OPENPATHS_MODEL_CATALOG,
} from "./models.js";

export const OPENPATHS_LEGACY_BASE_URL = "https://openpaths.io";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpenPathsBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENPATHS_BASE_URL || normalized === OPENPATHS_LEGACY_BASE_URL) {
    return OPENPATHS_BASE_URL;
  }
  return undefined;
}

export function buildOpenPathsProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENPATHS_BASE_URL,
    api: "openai-completions",
    models: OPENPATHS_MODEL_CATALOG.map(buildOpenPathsModelDefinition),
  };
}
