import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * The operator's text for a provider's own error type (`models.providers.<id>.failureCopy`), as failure copy. A
 * refusal the provider defines, such as an empty prepaid balance sent as a 401, reads as the operator wrote it instead
 * of as the failure class it lands in. Only the text changes: classification, fallback and cooldowns stay with the
 * class, and the provider's own message is never shown.
 */
export function renderProviderFailureCopy(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  errorType?: string;
}): string | undefined {
  const errorType = params.errorType?.trim();
  if (!errorType || !params.provider) {
    return undefined;
  }
  const copy = findNormalizedProviderValue(
    params.cfg?.models?.providers,
    params.provider,
  )?.failureCopy;
  const text = copy && Object.hasOwn(copy, errorType) ? copy[errorType]?.trim() : undefined;
  if (!text) {
    return undefined;
  }
  // Marked like the built-in failure copy, once.
  return text.startsWith("⚠️") ? text : `⚠️ ${text}`;
}
