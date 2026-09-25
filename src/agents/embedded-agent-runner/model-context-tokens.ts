/**
 * Reads normalized context-token metadata from resolved model definitions.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { Model } from "../../llm/types.js";

/** Returns finite context-token metadata when a model discovery source provided it. */
export function readAgentModelContextTokens(model: Model | null | undefined): number | undefined {
  return asFiniteNumber(model?.contextTokens);
}
