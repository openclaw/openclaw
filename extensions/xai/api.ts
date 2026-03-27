export { buildXaiProvider } from "./provider-catalog.js";
export {
  buildXaiCatalogModels,
  buildXaiModelDefinition,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
  XAI_DEFAULT_MAX_TOKENS,
} from "./model-definitions.js";
export { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";

export const XAI_TOOL_SCHEMA_PROFILE = "xai";
export const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";

export function applyXaiModelCompat<T extends { compat?: unknown }>(model: T): T {
  const patch = {
    toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
    nativeWebSearchTool: true,
    toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  } satisfies Record<string, unknown>;
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (compat && Object.entries(patch).every(([key, value]) => compat[key] === value)) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...patch,
    } as T extends { compat?: infer TCompat } ? TCompat : never,
  } as T;
}

export function normalizeXaiModelId(id: string): string {
  if (id === "grok-4-fast-reasoning") {
    return "grok-4-fast";
  }
  if (id === "grok-4-1-fast-reasoning") {
    return "grok-4-1-fast";
  }
  if (id === "grok-4.20-experimental-beta-0304-reasoning") {
    return "grok-4.20-beta-latest-reasoning";
  }
  if (id === "grok-4.20-experimental-beta-0304-non-reasoning") {
    return "grok-4.20-beta-latest-non-reasoning";
  }
  if (id === "grok-4.20-reasoning") {
    return "grok-4.20-beta-latest-reasoning";
  }
  if (id === "grok-4.20-non-reasoning") {
    return "grok-4.20-beta-latest-non-reasoning";
  }
  return id;
}
