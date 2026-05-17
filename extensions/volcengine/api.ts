import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";

const VOLCENGINE_CODING_PROVIDER_ID = "volcengine-plan";
export const VOLCENGINE_CODING_THINKING_FORMAT = "volcengine" as const;

export const VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
] as const;

function mergeUnsupportedToolSchemaKeywords(existing: readonly string[] | undefined): string[] {
  return Array.from(new Set([...(existing ?? []), ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS]));
}

function isVolcengineCodingPlanModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.provider === VOLCENGINE_CODING_PROVIDER_ID &&
    (model.api === undefined || model.api === "openai-completions")
  );
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && right.every((value, index) => left?.[index] === value);
}

export function resolveVolcengineToolSchemaCompatPatch(
  compat?: ModelCompatConfig,
): ModelCompatConfig {
  return {
    unsupportedToolSchemaKeywords: mergeUnsupportedToolSchemaKeywords(
      compat?.unsupportedToolSchemaKeywords,
    ),
  };
}

export function resolveVolcengineModelCompatPatch(
  model: { api?: unknown; provider?: unknown; compat?: ModelCompatConfig },
): ModelCompatConfig {
  return {
    ...resolveVolcengineToolSchemaCompatPatch(model.compat),
    ...(isVolcengineCodingPlanModel(model)
      ? { thinkingFormat: VOLCENGINE_CODING_THINKING_FORMAT }
      : {}),
  };
}

export function applyVolcengineToolSchemaCompat<T extends { compat?: ModelCompatConfig }>(
  model: T,
): T {
  const unsupportedToolSchemaKeywords = mergeUnsupportedToolSchemaKeywords(
    model.compat?.unsupportedToolSchemaKeywords,
  );
  if (
    sameStringList(model.compat?.unsupportedToolSchemaKeywords, unsupportedToolSchemaKeywords)
  ) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...model.compat,
      unsupportedToolSchemaKeywords,
    },
  };
}

export function applyVolcengineModelCompat<
  T extends { api?: unknown; provider?: unknown; compat?: ModelCompatConfig },
>(model: T): T {
  const patch = resolveVolcengineModelCompatPatch(model);
  if (
    sameStringList(
      model.compat?.unsupportedToolSchemaKeywords,
      patch.unsupportedToolSchemaKeywords ?? [],
    ) &&
    model.compat?.thinkingFormat === patch.thinkingFormat
  ) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...model.compat,
      ...patch,
    },
  };
}

export { buildDoubaoCodingProvider, buildDoubaoProvider } from "./provider-catalog.js";
export {
  buildDoubaoModelDefinition,
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
} from "./models.js";
