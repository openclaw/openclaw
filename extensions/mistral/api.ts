export { buildMistralProvider } from "./provider-catalog.js";
export {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
} from "./model-definitions.js";
export {
  applyMistralConfig,
  applyMistralProviderConfig,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./onboard.js";

const MISTRAL_MAX_TOKENS_FIELD = "max_tokens";

/** Transport-only flags merged for hinted Mistral routes; omits reasoning so `mistral-small-latest` is not clobbered after normalization. */
export const MISTRAL_MODEL_TRANSPORT_PATCH = {
  supportsStore: false,
  maxTokensField: MISTRAL_MAX_TOKENS_FIELD,
} as const satisfies {
  supportsStore: boolean;
  maxTokensField: "max_tokens";
};

/** Resolves to Mistral Chat Completions `reasoning_effort` (`none` | `high`). */
export const MISTRAL_SMALL_LATEST_REASONING_EFFORT_MAP: Record<string, string> = {
  off: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
  adaptive: "high",
};

export const MISTRAL_SMALL_LATEST_ID = "mistral-small-latest";

function mistralReasoningCompatForModelId(modelId: string | undefined): {
  supportsReasoningEffort: boolean;
  reasoningEffortMap?: Record<string, string>;
} {
  if (modelId === MISTRAL_SMALL_LATEST_ID) {
    return {
      supportsReasoningEffort: true,
      reasoningEffortMap: MISTRAL_SMALL_LATEST_REASONING_EFFORT_MAP,
    };
  }
  return { supportsReasoningEffort: false };
}

export function resolveMistralCompatPatch(model: { id?: string }): {
  supportsStore: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: "max_tokens";
  reasoningEffortMap?: Record<string, string>;
} {
  return {
    ...MISTRAL_MODEL_TRANSPORT_PATCH,
    ...mistralReasoningCompatForModelId(model.id),
  };
}

function compatMatchesResolved(
  compat: Record<string, unknown> | undefined,
  modelId: string | undefined,
): boolean {
  const expected = resolveMistralCompatPatch({ id: modelId });
  for (const [key, value] of Object.entries(expected)) {
    if (key === "reasoningEffortMap") {
      const a = compat?.[key];
      const b = value;
      if (a === b) {
        continue;
      }
      if (
        a &&
        b &&
        typeof a === "object" &&
        typeof b === "object" &&
        JSON.stringify(a) === JSON.stringify(b)
      ) {
        continue;
      }
      return false;
    }
    if (compat?.[key] !== value) {
      return false;
    }
  }
  return true;
}

export function applyMistralModelCompat<T extends { compat?: unknown; id?: string }>(model: T): T {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (compatMatchesResolved(compat, model.id)) {
    return model;
  }
  const patch = resolveMistralCompatPatch(model);
  return {
    ...model,
    compat: {
      ...compat,
      ...patch,
    } as T extends { compat?: infer TCompat } ? TCompat : never,
  } as T;
}
