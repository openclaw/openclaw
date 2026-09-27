const QA_LIVE_DEFAULT_MODEL = "openai/gpt-5.6-luna";

export function resolveQaLiveFrontierAlternateModel(primaryModel: string) {
  const normalized = primaryModel.toLowerCase();
  if (normalized === QA_LIVE_DEFAULT_MODEL) {
    return "openai/gpt-5.6-terra";
  }
  return normalized === "openai/gpt-5.6" ||
    normalized === "openai/gpt-5.6-sol" ||
    normalized === "openai/gpt-5.6-terra"
    ? QA_LIVE_DEFAULT_MODEL
    : undefined;
}
