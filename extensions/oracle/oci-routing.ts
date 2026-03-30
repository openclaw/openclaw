export type OracleChatApiFormat = "GENERIC" | "COHERE" | "COHEREV2";

export type OracleChatRequestFamily = "generic" | "cohere" | "cohere-v2";

export type OracleOutputTokenField = "maxTokens" | "maxCompletionTokens";

export type OracleModelRouting = {
  apiFormat: OracleChatApiFormat;
  family: OracleChatRequestFamily;
  outputTokenField: OracleOutputTokenField;
  catalogVisible: boolean;
};

const ORACLE_HIDDEN_ON_DEMAND_MODELS = new Set([
  "cohere.command-a-reasoning",
  "cohere.command-r-16k",
  "cohere.command-r-plus",
]);

const ORACLE_API_FORMAT_RULES: Array<{
  pattern: RegExp;
  apiFormat: OracleChatApiFormat;
}> = [
  { pattern: /^cohere\.command-a(?:$|[-.])/, apiFormat: "COHEREV2" },
  { pattern: /^cohere\.command-r7b(?:$|[-.])/, apiFormat: "COHEREV2" },
  { pattern: /^cohere\.command(?:$|[-.])/, apiFormat: "COHERE" },
];

function normalizeOracleModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveOracleChatApiFormat(modelId: string | undefined): OracleChatApiFormat {
  const normalized = normalizeOracleModelId(modelId);
  if (!normalized) {
    return "GENERIC";
  }

  for (const rule of ORACLE_API_FORMAT_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.apiFormat;
    }
  }

  if (!normalized.startsWith("cohere.")) {
    return "GENERIC";
  }

  return "COHERE";
}

export function resolveOracleModelRouting(modelId: string | undefined): OracleModelRouting {
  const normalized = normalizeOracleModelId(modelId);
  const apiFormat = resolveOracleChatApiFormat(normalized);

  return {
    apiFormat,
    family: apiFormat === "COHERE" ? "cohere" : apiFormat === "COHEREV2" ? "cohere-v2" : "generic",
    outputTokenField:
      apiFormat === "GENERIC" && normalized?.startsWith("openai.")
        ? "maxCompletionTokens"
        : "maxTokens",
    catalogVisible: normalized ? !ORACLE_HIDDEN_ON_DEMAND_MODELS.has(normalized) : true,
  };
}

export function isOracleCatalogModelVisible(modelId: string | undefined): boolean {
  return resolveOracleModelRouting(modelId).catalogVisible;
}
