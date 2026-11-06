import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseGoogleOauthApiKey } from "./oauth-token-shared.js";

export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  const parsed = apiKey.startsWith("{") ? parseGoogleOauthApiKey(apiKey) : null;
  return {
    headers: {
      ...(parsed?.token
        ? { Authorization: `Bearer ${parsed.token}` }
        : { "x-goog-api-key": apiKey }),
      "Content-Type": "application/json",
    },
  };
}

export function resolveGoogleEnvApiKey(): string | undefined {
  return (
    normalizeOptionalString(process.env.GEMINI_API_KEY) ??
    normalizeOptionalString(process.env.GOOGLE_API_KEY)
  );
}
