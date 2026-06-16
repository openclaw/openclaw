// Codex app-server model catalog bridge materializes OpenClaw model metadata for isolated homes.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { CodexAppServerStartOptions } from "./config.js";

export const CODEX_MODEL_CATALOG_FINGERPRINT_ENV = "OPENCLAW_CODEX_MODEL_CATALOG_FINGERPRINT";

const CODEX_CONFIG_TOML_FILENAME = "config.toml";
const CODEX_MODEL_CATALOG_FILENAME = "openclaw-model-catalog.json";
const CODEX_MODEL_CATALOG_FINGERPRINT_PREFIX = "sha256:";
const CODEX_MODEL_CATALOG_HASH_DOMAIN = "openclaw:codex-app-server-model-catalog:v1";
const DEFAULT_CONTEXT_WINDOW = 272_000;
const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const CODEX_COMPATIBLE_MODEL_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
]);

type ModelCatalogConfig = {
  models?: {
    providers?: Record<string, ModelProviderConfig | undefined>;
  };
};

type CodexReasoningEffortPresetJson = {
  effort: string;
  description: string;
};

type CodexModelCatalogEntryJson = {
  slug: string;
  display_name: string;
  description: string | null;
  default_reasoning_level?: string;
  supported_reasoning_levels: CodexReasoningEffortPresetJson[];
  shell_type: "shell_command";
  visibility: "list";
  supported_in_api: boolean;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: unknown[];
  default_service_tier: string | null;
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  model_messages: null;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: "auto";
  support_verbosity: boolean;
  default_verbosity: null;
  apply_patch_tool_type: null;
  web_search_tool_type: "text";
  truncation_policy: { mode: "bytes"; limit: number };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  context_window: number;
  max_context_window: number;
  auto_compact_token_limit: null;
  comp_hash: string | null;
  effective_context_window_percent: number;
  experimental_supported_tools: string[];
  input_modalities: Array<"text" | "image">;
  supports_search_tool: boolean;
  use_responses_lite: boolean;
  auto_review_model_override: null;
};

export type CodexModelCatalogJson = {
  models: CodexModelCatalogEntryJson[];
};

export async function provisionCodexAppServerModelCatalog(params: {
  startOptions: CodexAppServerStartOptions;
  codexHome: string;
  config?: unknown;
}): Promise<CodexAppServerStartOptions> {
  const catalog = buildCodexAppServerModelCatalog(params.config);
  if (!catalog) {
    return params.startOptions;
  }
  await fs.mkdir(params.codexHome, { recursive: true });
  const catalogPath = path.join(params.codexHome, CODEX_MODEL_CATALOG_FILENAME);
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  await fs.writeFile(catalogPath, catalogJson);
  await upsertCodexModelCatalogConfig(params.codexHome, catalogPath);
  const fingerprint = fingerprintCodexModelCatalogJson(catalogJson);
  return {
    ...params.startOptions,
    env: {
      ...params.startOptions.env,
      [CODEX_MODEL_CATALOG_FINGERPRINT_ENV]: fingerprint,
    },
  };
}

export function buildCodexAppServerModelCatalog(
  config: unknown,
): CodexModelCatalogJson | undefined {
  const providers = (config as ModelCatalogConfig | undefined)?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const entries: CodexModelCatalogEntryJson[] = [];
  const seenSlugs = new Set<string>();
  for (const [providerId, provider] of Object.entries(providers).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!provider?.models) {
      continue;
    }
    const normalizedProviderId = normalizeCatalogString(providerId);
    for (const model of provider.models) {
      if (!isCodexCatalogModel(provider, model)) {
        continue;
      }
      for (const slug of modelCatalogSlugs(normalizedProviderId, model.id)) {
        if (seenSlugs.has(slug)) {
          continue;
        }
        seenSlugs.add(slug);
        entries.push(buildCodexModelCatalogEntry(provider, model, slug, entries.length));
      }
    }
  }
  return entries.length > 0 ? { models: entries } : undefined;
}

function isCodexCatalogModel(
  provider: ModelProviderConfig,
  model: ModelDefinitionConfig | undefined,
): model is ModelDefinitionConfig {
  const id = normalizeCatalogString(model?.id);
  if (!id || !model?.input?.includes("text")) {
    return false;
  }
  const api = model.api ?? provider.api;
  return api ? CODEX_COMPATIBLE_MODEL_APIS.has(api) : true;
}

function modelCatalogSlugs(providerId: string, modelId: string): string[] {
  const id = normalizeCatalogString(modelId);
  if (!id) {
    return [];
  }
  const providerQualifiedId =
    providerId && !id.includes("/") ? normalizeCatalogString(`${providerId}/${id}`) : "";
  return providerQualifiedId && providerQualifiedId !== id ? [id, providerQualifiedId] : [id];
}

function buildCodexModelCatalogEntry(
  provider: ModelProviderConfig,
  model: ModelDefinitionConfig,
  slug: string,
  priority: number,
): CodexModelCatalogEntryJson {
  const contextWindow = normalizePositiveInteger(model.contextWindow ?? provider.contextWindow);
  const effectiveContextWindow =
    normalizePositiveInteger(model.contextTokens ?? provider.contextTokens) ?? contextWindow;
  const maxContextWindow = contextWindow ?? effectiveContextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const resolvedContextWindow = Math.min(
    effectiveContextWindow ?? maxContextWindow,
    maxContextWindow,
  );
  const reasoningEfforts = resolveSupportedReasoningEfforts(model);
  const defaultReasoningEffort = resolveDefaultReasoningEffort(reasoningEfforts);
  const supportsSearchTool = model.compat?.nativeWebSearchTool === true;
  return {
    slug,
    display_name: normalizeCatalogString(model.name) || slug,
    description: null,
    ...(defaultReasoningEffort ? { default_reasoning_level: defaultReasoningEffort } : {}),
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({
      effort,
      description: effort,
    })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are Codex, a coding agent.",
    model_messages: null,
    supports_reasoning_summaries: model.reasoning,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: model.compat?.supportsTools !== false,
    supports_image_detail_original: model.input.includes("image"),
    context_window: resolvedContextWindow,
    max_context_window: maxContextWindow,
    auto_compact_token_limit: null,
    comp_hash: fingerprintCodexModelSlug(slug, resolvedContextWindow, maxContextWindow),
    effective_context_window_percent: EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    experimental_supported_tools: [],
    input_modalities: model.input.includes("image") ? ["text", "image"] : ["text"],
    supports_search_tool: supportsSearchTool,
    use_responses_lite: false,
    auto_review_model_override: null,
  };
}

function resolveSupportedReasoningEfforts(model: ModelDefinitionConfig): string[] {
  const configured = model.compat?.supportedReasoningEfforts
    ?.map(normalizeCatalogString)
    .filter((entry): entry is string => Boolean(entry));
  const efforts =
    configured && configured.length > 0
      ? configured
      : model.reasoning
        ? ["low", "medium", "high"]
        : [];
  return [...new Set(efforts)];
}

function resolveDefaultReasoningEffort(efforts: string[]): string | undefined {
  if (efforts.length === 0) {
    return undefined;
  }
  return efforts.includes("medium") ? "medium" : efforts[0];
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeCatalogString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fingerprintCodexModelCatalogJson(catalogJson: string): string {
  const hash = createHash("sha256");
  hash.update(CODEX_MODEL_CATALOG_HASH_DOMAIN);
  hash.update("\0");
  hash.update(catalogJson);
  return `${CODEX_MODEL_CATALOG_FINGERPRINT_PREFIX}${hash.digest("hex")}`;
}

function fingerprintCodexModelSlug(
  slug: string,
  contextWindow: number,
  maxContextWindow: number,
): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex-app-server-model-info:v1");
  hash.update("\0");
  hash.update(slug);
  hash.update("\0");
  hash.update(String(contextWindow));
  hash.update("\0");
  hash.update(String(maxContextWindow));
  return `openclaw:${hash.digest("hex")}`;
}

async function upsertCodexModelCatalogConfig(
  codexHome: string,
  catalogPath: string,
): Promise<void> {
  const configPath = path.join(codexHome, CODEX_CONFIG_TOML_FILENAME);
  let content = "";
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const nextContent = upsertTopLevelTomlStringAssignment(
    content,
    "model_catalog_json",
    catalogPath,
  );
  if (nextContent !== content) {
    await fs.writeFile(configPath, nextContent);
  }
}

export function upsertTopLevelTomlStringAssignment(
  content: string,
  key: string,
  value: string,
): string {
  const assignment = `${key} = ${JSON.stringify(value)}`;
  const tableOffset = firstTomlTableOffset(content);
  const topLevel = content.slice(0, tableOffset);
  const rest = content.slice(tableOffset);
  const keyPattern = tomlKeyPattern(key);
  const existingTopLevelAssignment = new RegExp(`(^|\\n)\\s*${keyPattern}\\s*=.*(?=\\n|$)`);
  if (existingTopLevelAssignment.test(topLevel)) {
    return (
      topLevel.replace(
        existingTopLevelAssignment,
        (_match, prefix: string) => `${prefix}${assignment}`,
      ) + rest
    );
  }
  const prefix = topLevel.length === 0 || topLevel.endsWith("\n") ? topLevel : `${topLevel}\n`;
  return `${prefix}${assignment}\n${rest}`;
}

function firstTomlTableOffset(content: string): number {
  const match = /^\s*\[/m.exec(content);
  return match ? match.index : content.length;
}

function tomlKeyPattern(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:"${escaped}"|'${escaped}'|${escaped})`;
}
