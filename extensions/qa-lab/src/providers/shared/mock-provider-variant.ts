// Model identity, not HTTP route, selects the parity lane. An Anthropic wire
// request may intentionally carry an OpenAI model; debug consumers retain this
// classification to verify which provider-specific scenario plan was exercised.
export type MockProviderVariant = "openai" | "anthropic" | "unknown";

export function resolveMockProviderVariant(
  model: string | undefined,
  openAiAlias?: string,
): MockProviderVariant {
  if (typeof model !== "string") {
    return "unknown";
  }
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "unknown";
  }
  // Explicit provider prefixes take precedence over model-name hints.
  const separatorMatch = /^([^/:]+)[/:]/.exec(trimmed);
  const provider = separatorMatch?.[1] ?? trimmed;
  if (provider === "openai" || provider === openAiAlias) {
    return "openai";
  }
  if (provider === "anthropic" || provider === "claude-cli") {
    return "anthropic";
  }

  if (/^(?:gpt-|o1-|openai-)/.test(trimmed)) {
    return "openai";
  }
  if (/^(?:claude-|anthropic-)/.test(trimmed)) {
    return "anthropic";
  }
  return "unknown";
}
