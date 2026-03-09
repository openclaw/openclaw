import { redactIdentifier } from "../logging/redact-identifier.js";
import { redactSensitiveText } from "../logging/redact.js";
import { getApiErrorPayloadFingerprint, parseApiErrorInfo } from "./pi-embedded-helpers.js";

const RAW_ERROR_PREVIEW_MAX_CHARS = 400;
const PROVIDER_ERROR_PREVIEW_MAX_CHARS = 200;

function truncateForObservation(text: string | undefined, maxChars: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function replaceRequestIdPreview(
  text: string | undefined,
  requestId: string | undefined,
): string | undefined {
  if (!text || !requestId) {
    return text;
  }
  return text.split(requestId).join(redactIdentifier(requestId, { len: 12 }));
}

export function buildApiErrorObservationFields(rawError?: string): {
  rawErrorPreview?: string;
  rawErrorHash?: string;
  rawErrorFingerprint?: string;
  httpCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const trimmed = rawError?.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = parseApiErrorInfo(trimmed);
  const requestIdHash = parsed?.requestId
    ? redactIdentifier(parsed.requestId, { len: 12 })
    : undefined;
  const rawFingerprint = getApiErrorPayloadFingerprint(trimmed);
  const redactedRawPreview = replaceRequestIdPreview(
    redactSensitiveText(trimmed),
    parsed?.requestId,
  );
  const redactedProviderMessage = replaceRequestIdPreview(
    parsed?.message ? redactSensitiveText(parsed.message) : undefined,
    parsed?.requestId,
  );

  return {
    rawErrorPreview: truncateForObservation(redactedRawPreview, RAW_ERROR_PREVIEW_MAX_CHARS),
    rawErrorHash: redactIdentifier(trimmed, { len: 12 }),
    rawErrorFingerprint: rawFingerprint ? redactIdentifier(rawFingerprint, { len: 12 }) : undefined,
    httpCode: parsed?.httpCode,
    providerErrorType: parsed?.type,
    providerErrorMessagePreview: truncateForObservation(
      redactedProviderMessage,
      PROVIDER_ERROR_PREVIEW_MAX_CHARS,
    ),
    requestIdHash,
  };
}
