import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

// Users familiar with the OpenAI SDK often write `baseURL` (uppercase) while
// the openclaw config schema uses `baseUrl`. Accept both spellings so remote
// Ollama hosts are not silently ignored and requests do not fall back to
// localhost:11434.
export function readProviderBaseUrl(
  provider: ModelProviderConfig | (ModelProviderConfig & { baseURL?: string }) | undefined,
): string | undefined {
  if (!provider) return undefined;
  const url =
    (typeof provider.baseUrl === "string" && provider.baseUrl.trim()) ||
    (typeof (provider as { baseURL?: string }).baseURL === "string" &&
      (provider as { baseURL?: string }).baseURL!.trim());
  return url || undefined;
}
