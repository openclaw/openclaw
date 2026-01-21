import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return (
    api === "google-gemini-cli" || api === "google-generative-ai" || api === "google-antigravity"
  );
}

export function isAntigravityClaude(api?: string | null, modelId?: string): boolean {
  if (api !== "google-antigravity") return false;
  return modelId?.toLowerCase().includes("claude") ?? false;
}

export { sanitizeGoogleTurnOrdering };
