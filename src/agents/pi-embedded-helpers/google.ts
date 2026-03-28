import { isGoogleGenerativeAiApi } from "../../plugin-sdk/google.js";
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || isGoogleGenerativeAiApi(api);
}

export { sanitizeGoogleTurnOrdering };
