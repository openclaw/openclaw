import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-generative-ai";
}

export { sanitizeGoogleTurnOrdering };
