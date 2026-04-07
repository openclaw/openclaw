import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { findCatalogTemplate } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";

type SyntheticOpenAIModelCatalogEntry = {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  contextTokens?: number;
};

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export function toOpenAIDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export function resolveConfiguredOpenAIBaseUrl(cfg: OpenClawConfig | undefined): string {
  return cfg?.models?.providers?.openai?.baseUrl?.trim() || OPENAI_API_BASE_URL;
}

export function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

export function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/chatgpt\.com\/backend-api\/?$/i.test(trimmed);
}

export function buildOpenAISyntheticCatalogEntry(
  template: ReturnType<typeof findCatalogTemplate>,
  entry: {
    id: string;
    reasoning: boolean;
    input: readonly ("text" | "image")[];
    contextWindow: number;
    contextTokens?: number;
  },
): SyntheticOpenAIModelCatalogEntry | undefined {
  if (!template) {
    return undefined;
  }
  return {
    ...template,
    id: entry.id,
    name: entry.id,
    reasoning: entry.reasoning,
    input: [...entry.input],
    contextWindow: entry.contextWindow,
    ...(entry.contextTokens === undefined ? {} : { contextTokens: entry.contextTokens }),
  };
}

export { cloneFirstTemplateModel, findCatalogTemplate, matchesExactOrPrefix };
