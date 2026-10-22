import { shouldUseEnvHttpProxyForUrl } from "openclaw/plugin-sdk/fetch-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type LlamaCppMediaTask = "ocr" | "vision";

export const LLAMA_CPP_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const LLAMA_CPP_MEDIA_MAX_TOKENS = 2048;
export const LLAMA_CPP_MEDIA_MAX_CHARS = 12_000;
export const LLAMA_CPP_MEDIA_TIMEOUT_MS = 600_000;

/** Managed media never sends image bytes to an external provider endpoint. */
export function isManagedLlamaCppMediaProvider(provider: ModelProviderConfig | undefined): boolean {
  if (!provider?.localService || provider.request?.proxy?.mode === "explicit-proxy") {
    return false;
  }
  try {
    const url = new URL(provider.baseUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      !shouldUseEnvHttpProxyForUrl(url.href) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Saved recipe selections, never inferred from an image's prompt or filename. */
export function resolveLlamaCppMediaModels(
  provider: ModelProviderConfig | undefined,
): Record<LlamaCppMediaTask, string> | undefined {
  const models = provider?.params?.mediaModels;
  if (!isRecord(models)) {
    return undefined;
  }
  const ocr = normalizeOptionalString(models.ocr);
  const vision = normalizeOptionalString(models.vision);
  return ocr && vision ? { ocr, vision } : undefined;
}
