import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeToolParameterSchema,
  type ToolSchemaModelCompat,
} from "./agent-tools-parameter-schema.js";

export { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";

type ToolSchemaCompatInput = {
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
};

function resolveToolSchemaModelCompat(
  compat: ToolSchemaCompatInput | null | undefined,
): ToolSchemaModelCompat | undefined {
  if (!compat) {
    return undefined;
  }
  const unsupportedToolSchemaKeywords = filterStringEntries(compat.unsupportedToolSchemaKeywords);
  if (unsupportedToolSchemaKeywords.length === 0 && compat.omitEmptyArrayItems !== true) {
    return undefined;
  }
  return {
    ...(unsupportedToolSchemaKeywords.length > 0 ? { unsupportedToolSchemaKeywords } : {}),
    ...(compat.omitEmptyArrayItems === true ? { omitEmptyArrayItems: true } : {}),
  };
}

/** Normalizes tool parameters for an OpenAI-protocol request under the model's schema compat. */
export function normalizeOpenAIToolParameters<T>(
  schema: T,
  modelCompat?: ToolSchemaCompatInput | null,
): T {
  return normalizeToolParameterSchema(schema ?? {}, {
    modelCompat: resolveToolSchemaModelCompat(modelCompat),
  }) as T;
}

/**
 * Strict field for one OpenAI-protocol route, from the resolved model compat only. A route
 * that accepts the field gets explicit `strict: false` on every tool: OpenAI Responses treats
 * an omitted field as strict, and strict tools measured slower with no gain. Other routes omit
 * it. A provider plugin that wants strict tools sets them in its own payload hook.
 */
export function resolveOpenAIStrictToolSetting(compat: {
  supportsStrictMode?: boolean;
}): false | undefined {
  return compat.supportsStrictMode === true ? false : undefined;
}
