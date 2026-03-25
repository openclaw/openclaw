import { isGoogleGenerativeAiApi } from "../google-generative-ai.js";
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || isGoogleGenerativeAiApi(api);
}

export { sanitizeGoogleTurnOrdering };
