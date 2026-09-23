import {
  MODEL_CATALOG_THINKING_LEVELS,
  resolveOpenAIThinkingApi,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { clampThinkingLevel } from "../model-utils.js";
import { resolveOpenAIReasoningEffortMap } from "../transports/openai-reasoning-compat.js";
import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions } from "../types.js";
import {
  normalizeOpenAIReasoningEffort,
  resolveOpenAIModelReasoningEfforts,
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAIReasoningEffortMapping,
  supportsOpenAIReasoningEffort,
} from "./openai-reasoning-effort.js";

export type OpenAIRequestReasoningEffort = ModelThinkingLevel | "none";

/** Preserve explicit off until the selected route maps it to its native value. */
export function resolveOpenAISimpleReasoningEffort<TApi extends Api>(
  model: Model<TApi>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
): ModelThinkingLevel | undefined {
  return reasoning === undefined ? undefined : clampThinkingLevel(model, reasoning);
}

export function resolveOpenAIRequestReasoning(
  model: Pick<Model, "id" | "provider" | "api" | "reasoning" | "thinkingLevelMap"> & {
    compat?: unknown;
  },
  reasoning: string | undefined,
): { effort: string | undefined; thinkingEnabled: boolean | undefined } {
  // Logical off can map to a minimum effort; native none only uses its own explicit mapping.
  const requested = normalizeOpenAIReasoningEffort(reasoning ?? "off");
  const modelLevel = MODEL_CATALOG_THINKING_LEVELS.find((candidate) => candidate === requested);
  const modelMapped = modelLevel ? model.thinkingLevelMap?.[modelLevel] : undefined;
  const mapped =
    modelMapped === null
      ? null
      : (resolveOpenAIReasoningEffortMapping(requested, resolveOpenAIReasoningEffortMap(model)) ??
        modelMapped);
  const intent =
    mapped !== undefined ? mapped?.trim() : reasoning === undefined ? undefined : requested;
  const normalizedIntent = normalizeOpenAIReasoningEffort(intent ?? "off");
  const supported = resolveOpenAIModelReasoningEfforts(model);
  const effort =
    !model.reasoning || supported?.length === 0 || intent === undefined
      ? undefined
      : supported === undefined
        ? mapped !== undefined
          ? intent
          : requested === "off"
            ? "none"
            : requested
        : resolveOpenAIReasoningEffortForModel({
            model,
            effort: requested,
            fallbackMap: { [requested]: intent },
          });
  return {
    // Sol and Luna accept none on ChatGPT; other subscription models need route metadata.
    effort:
      effort === "none" &&
      resolveOpenAIThinkingApi(model.api) === "openai-chatgpt-responses" &&
      !supportsOpenAIReasoningEffort(
        model.id === "gpt-6-sol" || model.id === "gpt-6-luna" ? model : { compat: model.compat },
        "none",
      )
        ? undefined
        : effort,
    // Binary thinking is independent of scalar effort support.
    thinkingEnabled:
      intent === undefined
        ? undefined
        : model.reasoning && normalizedIntent !== "off" && normalizedIntent !== "none",
  };
}
