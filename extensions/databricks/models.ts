import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const DATABRICKS_PROVIDER_ID = "databricks";
const DATABRICKS_DEFAULT_MODEL_ID = "system.ai.claude-sonnet-4-5";
const DATABRICKS_SERVING_MODEL_ID = "databricks-claude-sonnet-4-5";
export const DATABRICKS_DEFAULT_MODEL_REF = `${DATABRICKS_PROVIDER_ID}/${DATABRICKS_DEFAULT_MODEL_ID}`;

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULT_MODEL: ModelDefinitionConfig = {
  id: DATABRICKS_DEFAULT_MODEL_ID,
  name: "Claude Sonnet 4.5 (Databricks)",
  reasoning: true,
  input: ["text", "image"],
  cost: DEFAULT_COST,
  contextWindow: 200000,
  maxTokens: 64000,
};

export const DATABRICKS_MODEL_CATALOG: ModelDefinitionConfig[] = [DEFAULT_MODEL];

const DATABRICKS_SERVING_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    ...DEFAULT_MODEL,
    id: DATABRICKS_SERVING_MODEL_ID,
    compat: { maxTokensField: "max_tokens" },
  },
];

function usesWorkspaceServing(baseUrl: string | undefined): boolean {
  return Boolean(
    baseUrl &&
    URL.canParse(baseUrl) &&
    new URL(baseUrl).pathname.replace(/\/+$/, "") === "/serving-endpoints",
  );
}

export function getDatabricksDefaultModelRef(baseUrl: string | undefined): string {
  const id = usesWorkspaceServing(baseUrl)
    ? DATABRICKS_SERVING_MODEL_ID
    : DATABRICKS_DEFAULT_MODEL_ID;
  return `${DATABRICKS_PROVIDER_ID}/${id}`;
}

export function getDatabricksModelCatalog(baseUrl: string): ModelDefinitionConfig[] {
  return structuredClone(
    usesWorkspaceServing(baseUrl) ? DATABRICKS_SERVING_MODEL_CATALOG : DATABRICKS_MODEL_CATALOG,
  );
}

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

export function resolveDatabricksBaseUrl(
  host: string | undefined,
  configuredBaseUrl?: string,
): string | undefined {
  const normalized = normalizeDatabricksHost(host);
  const path = usesWorkspaceServing(configuredBaseUrl)
    ? "/serving-endpoints"
    : "/ai-gateway/mlflow/v1";
  return normalized ? `${normalized}${path}` : undefined;
}

export function buildDatabricksModelDefinition(
  id: string,
  baseUrl?: string,
): ModelDefinitionConfig {
  const known = [...DATABRICKS_MODEL_CATALOG, ...DATABRICKS_SERVING_MODEL_CATALOG].find(
    (model) => model.id === id,
  );
  const model: ModelDefinitionConfig = known
    ? structuredClone(known)
    : {
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        cost: { ...DEFAULT_COST },
        contextWindow: 128000,
        maxTokens: 8192,
      };
  if (usesWorkspaceServing(baseUrl)) {
    model.compat = { ...model.compat, maxTokensField: "max_tokens" };
  }
  return model;
}
