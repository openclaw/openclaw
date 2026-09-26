// MiMo reasoning wiring for embedded extra params: model-id classification plus
// the strict reasoning-tag stream wrapper used when MiMo traffic bypasses the
// bundled Xiaomi provider hook. Kept beside extra-params.ts so the wrapper
// fallback stays readable without growing the caller past its line budget.
import { createStrictReasoningTagsWrapper } from "../../plugin-sdk/provider-stream-shared.js";
import type { StreamFn } from "../runtime/index.js";

/**
 * Normalize a provider model id to its lowercase leaf segment: drops any
 * `:variant` suffix and `provider/` prefix so proxy routes match the same set as
 * owned providers. Shared with the DeepSeek V4 family checks next door.
 */
export function normalizeReasoningFamilyModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase();
  const suffixIndex = normalized.indexOf(":");
  const withoutSuffix = suffixIndex === -1 ? normalized : normalized.slice(0, suffixIndex);
  return withoutSuffix.split("/").pop();
}

// mimo-v2.5+ models use the reasoning_content wire format; legacy mimo-v2-pro/omni
// intentionally put final answers in reasoning_content and must not be forced strict.
// Keep in sync with MIMO_REASONING_MODEL_IDS in extensions/xiaomi/thinking.ts
// (the owned-provider path); this set covers custom OpenAI-compatible proxies.
// Add new MiMo reasoning models to both lists or strict reasoning-tag protection
// silently misses one path.
const MIMO_STRICT_REASONING_TAGS_MODEL_IDS = new Set([
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed",
]);

/**
 * True when the model is a MiMo v2.5+ OpenAI-completions model.
 * Intentionally module-private: production observes it through
 * `createMiMoStrictReasoningTagsWrapper`, and tests through the extra-params seam.
 */
function isMiMoStrictReasoningTagsModel(model: Parameters<StreamFn>[0]): boolean {
  const normalizedModelId = normalizeReasoningFamilyModelId(model.id);
  return (
    model.api === "openai-completions" &&
    normalizedModelId !== undefined &&
    MIMO_STRICT_REASONING_TAGS_MODEL_IDS.has(normalizedModelId)
  );
}

/**
 * MiMo V2.6 can inline reasoning in `content` as ` thinking` blocks even with
 * `reasoning_effort: "no_think"`. The on-flush strict reasoning-tag policy hides
 * that reasoning at each flush boundary and until the next tool-call/stream
 * segment boundary, so reasoning-visibility toggles remain authoritative for the
 * leak this reproduces.
 */
export function createMiMoStrictReasoningTagsWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  return createStrictReasoningTagsWrapper({
    baseStreamFn,
    shouldMarkStrictOnFlush: isMiMoStrictReasoningTagsModel,
  });
}
