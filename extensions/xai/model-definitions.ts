import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL_ID = "grok-4";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
export const XAI_DEFAULT_CONTEXT_WINDOW = 131072;
export const XAI_LARGE_CONTEXT_WINDOW = 2_000_000;
export const XAI_CODE_CONTEXT_WINDOW = 256_000;
export const XAI_DEFAULT_MAX_TOKENS = 8192;
export const XAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type XaiCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
};

const XAI_MODEL_CATALOG = [
  {
    id: "grok-4",
    name: "Grok 4",
    reasoning: false,
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "grok-4-0709",
    name: "Grok 4 0709",
    reasoning: false,
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "grok-4-fast-reasoning",
    name: "Grok 4 Fast (Reasoning)",
    reasoning: true,
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
  },
  {
    id: "grok-4-fast-non-reasoning",
    name: "Grok 4 Fast (Non-Reasoning)",
    reasoning: false,
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
  },
  {
    id: "grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast (Reasoning)",
    reasoning: true,
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast (Non-Reasoning)",
    reasoning: false,
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
  },
  {
    id: "grok-4.20-experimental-beta-0304-reasoning",
    name: "Grok 4.20 Experimental Beta 0304 (Reasoning)",
    reasoning: true,
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
  },
  {
    id: "grok-4.20-experimental-beta-0304-non-reasoning",
    name: "Grok 4.20 Experimental Beta 0304 (Non-Reasoning)",
    reasoning: false,
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: true,
    contextWindow: XAI_CODE_CONTEXT_WINDOW,
  },
] as const satisfies readonly XaiCatalogEntry[];

function toModelDefinition(entry: XaiCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: ["text"],
    cost: XAI_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
  };
}

export function buildXaiModelDefinition(): ModelDefinitionConfig {
  return toModelDefinition(
    XAI_MODEL_CATALOG.find((entry) => entry.id === XAI_DEFAULT_MODEL_ID) ?? {
      id: XAI_DEFAULT_MODEL_ID,
      name: "Grok 4",
      reasoning: false,
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    },
  );
}

export function buildXaiCatalogModels(): ModelDefinitionConfig[] {
  return XAI_MODEL_CATALOG.map((entry) => toModelDefinition(entry));
}

export function resolveXaiCatalogEntry(modelId: string): ModelDefinitionConfig | undefined {
  const lower = modelId.trim().toLowerCase();
  const exact = XAI_MODEL_CATALOG.find((entry) => entry.id.toLowerCase() === lower);
  if (exact) {
    return toModelDefinition(exact);
  }
  if (lower.includes("multi-agent")) {
    return undefined;
  }
  if (lower.startsWith("grok-code-fast")) {
    return toModelDefinition({
      id: modelId.trim(),
      name: modelId.trim(),
      reasoning: true,
      contextWindow: XAI_CODE_CONTEXT_WINDOW,
    });
  }
  if (
    lower.startsWith("grok-4.20") ||
    lower.startsWith("grok-4-1") ||
    lower.startsWith("grok-4-fast")
  ) {
    return toModelDefinition({
      id: modelId.trim(),
      name: modelId.trim(),
      reasoning: !lower.includes("non-reasoning"),
      contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    });
  }
  if (lower.startsWith("grok-4")) {
    return toModelDefinition({
      id: modelId.trim(),
      name: modelId.trim(),
      reasoning: lower.includes("reasoning"),
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    });
  }
  return undefined;
}
