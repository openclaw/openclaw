import { stableStringify } from "@openclaw/normalization-core";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readLoggingConfig } from "../logging/config.js";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import { parseApiErrorInfo } from "../shared/assistant-error-format.js";
import {
  classifyProviderRuntimeFailureKind,
  type ProviderRuntimeFailureKind,
} from "./embedded-agent-helpers/provider-runtime-failure.js";
import type { PreparedProviderFailoverOwner } from "./failover/provider-patterns.js";
import { getApiErrorPayloadFingerprint } from "./failover/user-copy.js";

const MAX_OBSERVATION_INPUT_CHARS = 64_000;
const MAX_FINGERPRINT_MESSAGE_CHARS = 8_000;
const RAW_ERROR_PREVIEW_MAX_CHARS = 400;
const PROVIDER_ERROR_PREVIEW_MAX_CHARS = 200;
const REQUEST_ID_RE = /\brequest[_ ]?id\b\s*[:=]\s*["'()]*([A-Za-z0-9._:-]+)/i;
const OBSERVATION_EXTRA_REDACT_PATTERNS = [
  String.raw`\b(?:x-)?api[-_]?key\b\s*[:=]\s*(["']?)([^\s"'\\;]+)\1`,
  String.raw`"(?:api[-_]?key|api_key)"\s*:\s*"([^"]+)"`,
  String.raw`(?:\bCookie\b\s*[:=]\s*[^;=\s]+=|;\s*[^;=\s]+=)([^;\s\r\n]+)`,
];

function truncateForObservation(text: string | undefined, maxChars: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxChars ? `${truncateUtf16Safe(trimmed, maxChars)}…` : trimmed;
}

function boundObservationInput(text: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(text);
  return trimmed ? truncateUtf16Safe(trimmed, MAX_OBSERVATION_INPUT_CHARS) : undefined;
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

function redactObservationText(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }
  // Client-visible error observations retain masking even when general-purpose
  // log redaction is disabled. Include the default programmatic matchers as well
  // as configured string patterns.
  const configuredPatterns = filterStringEntries(readLoggingConfig()?.redactPatterns);
  return redactSensitiveText(text, {
    mode: "tools",
    patterns: [
      ...getDefaultRedactPatterns(),
      ...configuredPatterns,
      ...OBSERVATION_EXTRA_REDACT_PATTERNS,
    ],
  });
}

export function buildApiErrorObservationFields(
  rawError?: string,
  opts?: { provider?: string; providerOwner?: PreparedProviderFailoverOwner; code?: string },
): {
  rawErrorPreview?: string;
  rawErrorHash?: string;
  rawErrorFingerprint?: string;
  httpCode?: string;
  providerRuntimeFailureKind?: ProviderRuntimeFailureKind;
  providerErrorCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const trimmed = boundObservationInput(rawError);
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = parseApiErrorInfo(trimmed);
    const requestId =
      parsed?.requestId ?? normalizeOptionalString(trimmed.match(REQUEST_ID_RE)?.[1]);
    const requestIdHash = requestId ? redactIdentifier(requestId, { len: 12 }) : undefined;
    const boundedMessage =
      parsed?.message && truncateUtf16Safe(parsed.message, MAX_FINGERPRINT_MESSAGE_CHARS);
    const structured =
      parsed?.httpCode || parsed?.type || boundedMessage
        ? stableStringify({
            httpCode: parsed?.httpCode,
            type: parsed?.type,
            message: boundedMessage,
          })
        : null;
    const rawFingerprint =
      structured ||
      (requestId
        ? trimmed.split(requestId).join("<request_id>")
        : getApiErrorPayloadFingerprint(trimmed));
    const redactedRawPreview = replaceRequestIdPreview(redactObservationText(trimmed), requestId);
    const redactedProviderMessage = replaceRequestIdPreview(
      redactObservationText(parsed?.message),
      requestId,
    );

    return {
      rawErrorPreview: truncateForObservation(redactedRawPreview, RAW_ERROR_PREVIEW_MAX_CHARS),
      rawErrorHash: redactIdentifier(trimmed, { len: 12 }),
      rawErrorFingerprint: rawFingerprint
        ? redactIdentifier(rawFingerprint, { len: 12 })
        : undefined,
      httpCode: parsed?.httpCode,
      providerRuntimeFailureKind: classifyProviderRuntimeFailureKind(
        {
          status: parsed?.httpCode ? Number(parsed.httpCode) : undefined,
          message: trimmed,
          provider: opts?.providerOwner?.id ?? opts?.provider,
        },
        { providerPlugin: opts?.providerOwner ?? null },
      ),
      providerErrorCode: redactObservationText(opts?.code ?? parsed?.code),
      providerErrorType: redactObservationText(parsed?.type),
      providerErrorMessagePreview: truncateForObservation(
        redactedProviderMessage,
        PROVIDER_ERROR_PREVIEW_MAX_CHARS,
      ),
      requestIdHash,
    };
  } catch {
    return {};
  }
}

export function buildTextObservationFields(
  text?: string,
  opts?: { provider?: string; providerOwner?: PreparedProviderFailoverOwner },
): {
  textPreview?: string;
  textHash?: string;
  textFingerprint?: string;
  httpCode?: string;
  providerRuntimeFailureKind?: ProviderRuntimeFailureKind;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const observed = buildApiErrorObservationFields(text, opts);
  return {
    textPreview: observed.rawErrorPreview,
    textHash: observed.rawErrorHash,
    textFingerprint: observed.rawErrorFingerprint,
    httpCode: observed.httpCode,
    providerRuntimeFailureKind: observed.providerRuntimeFailureKind,
    providerErrorType: observed.providerErrorType,
    providerErrorMessagePreview: observed.providerErrorMessagePreview,
    requestIdHash: observed.requestIdHash,
  };
}
