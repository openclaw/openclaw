import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENAI_GPT_56_SOL_MODEL_ID,
  OPENAI_GPT_56_TERRA_MODEL_ID,
  OPENAI_GPT_56_LUNA_MODEL_ID,
  resolveOpenAICodexReasoningEfforts,
} from "./model-route-contract.js";
import { OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS } from "./shared.js";

const OPENAI_CODEX_GPT_56_CONTEXT_WINDOW = 372_000;

export type OpenAILiveModelReaders = Pick<
  typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime"),
  | "readLiveModelCatalogBooleanField"
  | "readLiveModelCatalogPositiveSafeIntegerField"
  | "readLiveModelCatalogStringField"
>;

export function readCodexReasoningLevels(row: unknown): readonly string[] | undefined {
  const record = asOptionalRecord(row);
  const value = record?.supported_reasoning_levels ?? record?.supportedReasoningLevels;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [entry.trim()];
    }
    const effort = asOptionalRecord(entry)?.effort;
    return typeof effort === "string" && effort.trim().length > 0 ? [effort.trim()] : [];
  });
}

export function readCodexModelRows(body: unknown): readonly unknown[] {
  const models = asOptionalRecord(body)?.models;
  if (!Array.isArray(models)) {
    throw new Error("OpenAI Codex model discovery response must be { models: [] }");
  }
  return models;
}

export function shouldIncludeCodexModelRow(row: unknown, readers: OpenAILiveModelReaders): boolean {
  const { readLiveModelCatalogStringField, readLiveModelCatalogBooleanField } = readers;
  const visibility = normalizeLowercaseStringOrEmpty(
    readLiveModelCatalogStringField(row, "visibility") ?? "",
  );
  if (visibility && visibility !== "list") {
    return false;
  }
  const showInPicker =
    readLiveModelCatalogBooleanField(row, "show_in_picker") ??
    readLiveModelCatalogBooleanField(row, "showInPicker");
  return showInPicker !== false;
}

export function resolveCodexModelInput(
  row: unknown,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig["input"] {
  const record = asOptionalRecord(row);
  const rawModalities =
    [record?.input_modalities, record?.inputModalities]
      .find(Array.isArray)
      ?.filter((entry): entry is string => typeof entry === "string") ?? [];
  if (rawModalities.length === 0) {
    return fallback?.input ?? ["text", "image"];
  }
  const modalities = new Set(
    rawModalities.map((modality) => normalizeLowercaseStringOrEmpty(modality)),
  );
  const input = (["text", "image", "audio", "video"] as const).filter(
    (modality) => modalities.has(modality) || (modality === "image" && modalities.has("vision")),
  );
  return input.length > 0 ? input : (fallback?.input ?? ["text", "image"]);
}

export function normalizeOpenAICodexCatalogModel(
  model: ModelDefinitionConfig,
): ModelDefinitionConfig {
  const modelId = normalizeLowercaseStringOrEmpty(model.id);
  if (
    modelId === OPENAI_GPT_56_SOL_MODEL_ID ||
    modelId === OPENAI_GPT_56_TERRA_MODEL_ID ||
    modelId === OPENAI_GPT_56_LUNA_MODEL_ID
  ) {
    const supportedReasoningEfforts = resolveOpenAICodexReasoningEfforts(
      modelId,
      model.compat?.supportedReasoningEfforts?.filter((effort) => effort !== "none"),
    );
    return {
      ...model,
      contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_WINDOW,
      contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      thinkingLevelMap: { ...model.thinkingLevelMap, off: null },
      ...(model.compat
        ? {
            compat: {
              ...model.compat,
              ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
            },
          }
        : {}),
    };
  }
  return model;
}
