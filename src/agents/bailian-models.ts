import type { ModelDefinitionConfig } from "../config/types.js";

/**
 * Alibaba Cloud Bailian (DashScope) model definitions.
 *
 * Bailian (百炼) provides OpenAI-compatible API endpoints via DashScope.
 * Authentication requires a DashScope API Key (DASHSCOPE_API_KEY).
 *
 * Endpoints:
 * - Pay-as-you-go China (Beijing): https://dashscope.aliyuncs.com/compatible-mode/v1
 * - Pay-as-you-go International (Singapore): https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * - Pay-as-you-go US (Virginia): https://dashscope-us.aliyuncs.com/compatible-mode/v1
 * - Coding Plan China: https://coding.dashscope.aliyuncs.com/v1
 * - Coding Plan International: https://coding-intl.dashscope.aliyuncs.com/v1
 */

// Pay-as-you-go endpoints
export const BAILIAN_PAYG_BASE_URL_CN = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const BAILIAN_PAYG_BASE_URL_INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const BAILIAN_PAYG_BASE_URL_US = "https://dashscope-us.aliyuncs.com/compatible-mode/v1";

// Coding Plan endpoints
export const BAILIAN_CODING_BASE_URL_CN = "https://coding.dashscope.aliyuncs.com/v1";
export const BAILIAN_CODING_BASE_URL_INTL = "https://coding-intl.dashscope.aliyuncs.com/v1";

/**
 * Default model for Bailian provider.
 * Used when user doesn't specify a model.
 * Latest generation flagship with balanced performance.
 */
export const BAILIAN_DEFAULT_MODEL_ID = "qwen3.5-plus";
export const BAILIAN_DEFAULT_MODEL_REF = `bailian/${BAILIAN_DEFAULT_MODEL_ID}`;

/**
 * Approximate pricing for Bailian models (USD per 1K tokens).
 * Actual pricing may vary by region and contract.
 * Source: https://help.aliyun.com/zh/model-studio/pricing
 */
export const BAILIAN_DEFAULT_COST = {
  input: 0.002, // $0.002 per 1K tokens (input)
  output: 0.006, // $0.006 per 1K tokens (output)
  cacheRead: 0.0005, // $0.0005 per 1K tokens (cache read)
  cacheWrite: 0.001, // $0.001 per 1K tokens (cache write)
};

/**
 * Catalog entry type for Bailian models.
 */
export type BailianModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ReadonlyArray<ModelDefinitionConfig["input"][number]>;
  contextWindow: number;
  maxTokens: number;
};

/**
 * Complete catalog of Bailian (Qwen) models.
 *
 * This includes:
 * - Qwen Max: Best for complex reasoning and multi-step tasks
 * - Qwen Flash: Fast and cost-effective for simple tasks
 * - Qwen3 Coder Plus: Optimized for coding tasks
 * - Qwen3 series: Latest general-purpose models
 * - Qwen2.5 series: Previous generation models
 */
export const DASHSCOPE_MODEL_CATALOG = [
  /**
   * Qwen Max - Premium model for complex tasks
   */
  {
    id: "qwen-max",
    name: "Qwen Max",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 100000,
    maxTokens: 13000,
  },
  /**
   * Qwen Flash - Fast and economical
   */
  {
    id: "qwen-flash",
    name: "Qwen Flash",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  /**
   * Qwen Plus - Balanced performance and cost
   * Official Alibaba Cloud recommended model
   */
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  /**
   * Qwen3.5 Plus - High performance general model
   * Latest generation flagship for complex tasks
   */
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 256000,
  },
  /**
   * Qwen3 Coder Plus - Coding specialist
   */
  {
    id: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 1000000,
    maxTokens: 100000,
  },
  /**
   * Qwen3 14B - Mid-size general purpose
   */
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 8192,
  },
  /**
   * Qwen3 32B - Large general purpose
   */
  {
    id: "qwen3-32b",
    name: "Qwen3 32B",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 16384,
  },
  /**
   * Qwen2.5 72B - Previous generation flagship
   */
  {
    id: "qwen2.5-72b-instruct",
    name: "Qwen2.5 72B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  /**
   * Qwen2.5 32B - Previous generation large
   */
  {
    id: "qwen2.5-32b-instruct",
    name: "Qwen2.5 32B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  /**
   * Qwen2.5 14B - Previous generation mid-size
   */
  {
    id: "qwen2.5-14b-instruct",
    name: "Qwen2.5 14B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  /**
   * Qwen2.5 7B - Previous generation small
   */
  {
    id: "qwen2.5-7b-instruct",
    name: "Qwen2.5 7B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  /**
   * Qwen2.5 Coder 32B - Coding specialist (previous gen)
   */
  {
    id: "qwen2.5-coder-32b-instruct",
    name: "Qwen2.5 Coder 32B Instruct",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  /**
   * Qwen VL Max - Vision-language specialist
   */
  {
    id: "qwen-vl-max",
    name: "Qwen VL Max",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 32000,
    maxTokens: 4096,
  },
  /**
   * Qwen Audio - Audio processing specialist
   */
  {
    id: "qwen-audio",
    name: "Qwen Audio",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 8000,
    maxTokens: 2048,
  },
] as const;

/**
 * Type for catalog entries.
 */
export type BailianCatalogEntry = (typeof DASHSCOPE_MODEL_CATALOG)[number];

/**
 * Build a model definition from a catalog entry.
 *
 * @param entry - Catalog entry for the model
 * @param cost - Optional cost override (uses default if not provided)
 * @returns ModelDefinitionConfig for OpenClaw
 */
export function buildBailianModelDefinition(
  entry: BailianCatalogEntry,
  cost: ModelDefinitionConfig["cost"] = BAILIAN_DEFAULT_COST,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

/**
 * Get the appropriate base URL based on region.
 *
 * @param region - Region code: 'cn', 'intl', or 'us'
 * @returns Base URL for the selected region
 */
export function getBailianBaseUrl(region: "cn" | "intl" | "us" = "intl"): string {
  switch (region) {
    case "cn":
      return BAILIAN_PAYG_BASE_URL_CN;
    case "us":
      return BAILIAN_PAYG_BASE_URL_US;
    case "intl":
    default:
      return BAILIAN_PAYG_BASE_URL_INTL;
  }
}
