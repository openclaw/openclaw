import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export const VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
] as const;

export function applyVolcengineToolSchemaCompat<T extends { compat?: ModelCompatConfig }>(
  model: T,
): T {
  const existing = model.compat?.unsupportedToolSchemaKeywords;
  const merged = uniqueStrings([
    ...(existing ?? []),
    ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS,
  ]);
  return applyModelCompatPatch(model, {
    unsupportedToolSchemaKeywords:
      existing?.length === merged.length &&
      existing.every((value, index) => value === merged[index])
        ? existing
        : merged,
  });
}

export {
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
} from "./models.js";
