const ANTIGRAVITY_BARE_PRO_IDS = new Set(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"]);
const GOOGLE_PROVIDER_PREFIX = "google/";
const GOOGLE_MODEL_ALIASES = new Map([
  ["gemini-3-pro", "gemini-3.1-pro-preview"],
  ["gemini-3-pro-preview", "gemini-3.1-pro-preview"],
  ["gemini-3-flash", "gemini-3-flash-preview"],
  ["gemini-3.1-pro", "gemini-3.1-pro-preview"],
  // The Flash Lite preview endpoint retired after the model graduated to GA.
  ["gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite"],
  ["gemini-3.1-flash", "gemini-3-flash-preview"],
  ["gemini-3.1-flash-preview", "gemini-3-flash-preview"],
  ["gemma-4-26b", "gemma-4-26b-a4b-it"],
]);

export function normalizeGooglePreviewModelId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = id.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedModelId = normalizeGooglePreviewModelId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  return GOOGLE_MODEL_ALIASES.get(id) ?? id;
}

export function normalizeTogetherModelId(id: string): string {
  return id === "moonshotai/Kimi-K2.5" ? "moonshotai/Kimi-K2.6" : id;
}

export function normalizeAntigravityPreviewModelId(id: string): string {
  if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) {
    return `${id}-low`;
  }
  return id;
}
