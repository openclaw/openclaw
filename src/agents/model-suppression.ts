import { normalizeProviderId } from "./model-selection.js";

const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);

export function shouldSuppressBuiltInModel(params: {
  provider?: string | null;
  id?: string | null;
}) {
  const provider = normalizeProviderId(params.provider?.trim().toLowerCase() ?? "");
  const id = params.id?.trim().toLowerCase() ?? "";

  // pi-ai still ships non-Codex Spark rows, but OpenClaw treats Spark as
  // Codex-only until upstream availability is proven on direct API paths.
  return SUPPRESSED_SPARK_PROVIDERS.has(provider) && id === OPENAI_DIRECT_SPARK_MODEL_ID;
}

export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
}): string | undefined {
  if (!shouldSuppressBuiltInModel(params)) {
    return undefined;
  }
  const provider = normalizeProviderId(params.provider?.trim().toLowerCase() ?? "") || "openai";
  return `Unknown model: ${provider}/${OPENAI_DIRECT_SPARK_MODEL_ID}. ${OPENAI_DIRECT_SPARK_MODEL_ID} is only supported via openai-codex OAuth. Use openai-codex/${OPENAI_DIRECT_SPARK_MODEL_ID}.`;
}
