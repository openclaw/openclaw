import { z } from "zod";
import { DecisionRouteCapabilitiesSchema } from "./decision-route-capabilities.js";

/** Provider-declared facts for one physical route; never execution or grounding authority. */
export const ModelInferenceCapabilitiesSchema = z.object({
  /** Explicit declarations never infer chat support from text encoding or structured output. */
  chat: z.boolean(),
  /**
   * Weak evidence against a `chat: true` row (its ID names a non-text family, a provider
   * prior, or an unfamiliar kind value): default pickers and automatic choices skip it, while
   * typed and configured refs still run. Readers that predate it drop the key and see chat.
   */
  chatEvidence: z.literal("unlikely").optional(),
  decision: DecisionRouteCapabilitiesSchema.optional(),
});

/** Additive catalog metadata; the shipped conversational Model type remains unchanged. */
export type ModelInferenceCapabilities = z.infer<typeof ModelInferenceCapabilitiesSchema>;
export type ModelDecisionCapabilities = NonNullable<ModelInferenceCapabilities["decision"]>;
