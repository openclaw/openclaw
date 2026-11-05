import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ModelCatalogModel } from "./model-catalog-types.js";

const OPENROUTER_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Preserve OpenRouter's declared effort choices and mandatory-thinking wire contract. */
export function normalizeOpenRouterModelReasoning(
  value: unknown,
): Pick<ModelCatalogModel, "reasoning" | "compat" | "thinkingLevelMap"> | undefined {
  const reasoning = asOptionalRecord(value);
  const rawEfforts = reasoning?.supported_efforts;
  if (
    !reasoning ||
    typeof reasoning.mandatory !== "boolean" ||
    (rawEfforts !== undefined && rawEfforts !== null && !Array.isArray(rawEfforts))
  ) {
    return undefined;
  }
  // OpenRouter uses null for all gateway efforts; omission means no effort selector.
  const efforts =
    rawEfforts === undefined
      ? undefined
      : rawEfforts === null
        ? OPENROUTER_REASONING_EFFORTS
        : normalizeTrimmedStringList(rawEfforts);
  const mandatory = reasoning.mandatory;
  const supportedReasoningEfforts = efforts?.length
    ? [...new Set(mandatory ? efforts.filter((effort) => effort !== "none") : ["none", ...efforts])]
    : efforts;
  return {
    reasoning: true,
    compat: {
      supportsReasoningEffort: (supportedReasoningEfforts?.length ?? 0) > 0,
      ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
    },
    ...(mandatory ? { thinkingLevelMap: { off: null } } : {}),
  };
}
