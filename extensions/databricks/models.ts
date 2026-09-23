import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const DATABRICKS_PROVIDER_ID = "databricks";
const DATABRICKS_DEFAULT_MODEL_ID = "system.ai.claude-sonnet-4-5";
export const DATABRICKS_DEFAULT_MODEL_REF = `${DATABRICKS_PROVIDER_ID}/${DATABRICKS_DEFAULT_MODEL_ID}`;

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const DATABRICKS_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: DATABRICKS_DEFAULT_MODEL_ID,
    name: "Claude Sonnet 4.5 (Databricks)",
    reasoning: true,
    input: ["text", "image"],
    cost: DEFAULT_COST,
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "system.ai.gpt-5-6-sol",
    name: "GPT-5.6 Sol (Databricks)",
    reasoning: true,
    input: ["text", "image"],
    cost: DEFAULT_COST,
    contextWindow: 1050000,
    maxTokens: 128000,
  },
];

export function normalizeDatabricksHost(host: string | undefined): string | undefined {
  const trimmed = host?.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return undefined;
  }
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) {
    return undefined;
  }
  const url = new URL(candidate);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return url.origin;
}

export function resolveDatabricksBaseUrl(host: string | undefined): string | undefined {
  const normalized = normalizeDatabricksHost(host);
  return normalized ? `${normalized}/ai-gateway/mlflow/v1` : undefined;
}

export function buildDatabricksModelDefinition(id: string): ModelDefinitionConfig {
  const known = DATABRICKS_MODEL_CATALOG.find((model) => model.id === id);
  if (known) {
    return structuredClone(known);
  }
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { ...DEFAULT_COST },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}
