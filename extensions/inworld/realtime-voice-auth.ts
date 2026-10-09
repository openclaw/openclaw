import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function hasInworldRealtimeApiKeyInput(configApiKey: string | undefined): boolean {
  return Boolean(
    normalizeOptionalString(configApiKey) ?? normalizeOptionalString(process.env.INWORLD_API_KEY),
  );
}

export async function resolveInworldRealtimeApiKey(
  configApiKey: string | undefined,
): Promise<string> {
  const direct =
    normalizeOptionalString(configApiKey) ?? normalizeOptionalString(process.env.INWORLD_API_KEY);
  if (direct) {
    return direct;
  }
  throw new Error(
    "Inworld credentials missing for realtime voice. Set talk.realtime.providers.inworld.apiKey (or the voice-call realtime provider config) or INWORLD_API_KEY.",
  );
}
