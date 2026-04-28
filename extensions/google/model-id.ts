const ANTIGRAVITY_BARE_PRO_IDS = new Set(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"]);
const GOOGLE_MODEL_PREFIXES = ["models/google/", "models/gemini/", "google/", "gemini/", "models/"];

function stripGoogleModelPrefixes(id: string): string {
  let modelId = id.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const normalized = modelId.toLowerCase();
    for (const prefix of GOOGLE_MODEL_PREFIXES) {
      if (normalized.startsWith(prefix)) {
        modelId = modelId.slice(prefix.length);
        changed = true;
        break;
      }
    }
  }
  return modelId;
}

export function normalizeGoogleModelId(id: string): string {
  const modelId = stripGoogleModelPrefixes(id);
  if (modelId === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  if (modelId === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  // Google exposes Gemini 3.1 Pro in the Gemini API as the preview-suffixed id.
  // Keep the bare form as a user convenience alias, not as a canonical API id.
  if (modelId === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (modelId === "gemini-3.1-flash-lite") {
    return "gemini-3.1-flash-lite-preview";
  }
  if (modelId === "gemini-3.1-flash" || modelId === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  return modelId;
}

export function normalizeAntigravityModelId(id: string): string {
  if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) {
    return `${id}-low`;
  }
  return id;
}
