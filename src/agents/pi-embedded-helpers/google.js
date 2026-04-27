import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";
export function isGoogleModelApi(api) {
    return api === "google-gemini-cli" || api === "google-generative-ai";
}
export { sanitizeGoogleTurnOrdering };
