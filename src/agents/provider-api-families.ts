const GPT_RESPONSES_FAMILY_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export function isGptResponsesFamily(api: unknown): boolean {
  return typeof api === "string" && GPT_RESPONSES_FAMILY_APIS.has(api);
}
