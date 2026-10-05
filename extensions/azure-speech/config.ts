import {
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function readAzureSpeechEnvApiKey(): string | undefined {
  return (
    trimToUndefined(process.env.AZURE_SPEECH_KEY) ??
    trimToUndefined(process.env.AZURE_SPEECH_API_KEY) ??
    trimToUndefined(process.env.SPEECH_KEY)
  );
}

export function readAzureSpeechEnvRegion(): string | undefined {
  return (
    trimToUndefined(process.env.AZURE_SPEECH_REGION) ?? trimToUndefined(process.env.SPEECH_REGION)
  );
}

export function resolveAzureSpeechConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(rawConfig.providers);
  return (
    asOptionalRecord(providers?.["azure-speech"]) ??
    asOptionalRecord(providers?.azure) ??
    asOptionalRecord(rawConfig["azure-speech"]) ??
    asOptionalRecord(rawConfig.azure)
  );
}
