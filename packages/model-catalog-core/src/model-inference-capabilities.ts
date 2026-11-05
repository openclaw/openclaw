import { z } from "zod";
import { DecisionRouteCapabilitiesSchema } from "./decision-route-capabilities.js";

/** Provider-declared facts for one physical route; never execution or grounding authority. */
export const ModelInferenceCapabilitiesSchema = z.object({
  /** Explicit declarations never infer chat support from text encoding or structured output. */
  chat: z.boolean(),
  decision: DecisionRouteCapabilitiesSchema.optional(),
});

/** Additive catalog metadata; the shipped conversational Model type remains unchanged. */
export type ModelInferenceCapabilities = z.infer<typeof ModelInferenceCapabilitiesSchema>;
export type ModelDecisionCapabilities = NonNullable<ModelInferenceCapabilities["decision"]>;
