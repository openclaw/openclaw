/**
 * Redacts diagnostic payloads before persistence. It removes credential-like
 * fields, masks embedded auth strings, and replaces media/base64 data with
 * size and digest metadata.
 */
import { projectDiagnosticValue, type DiagnosticProjectionPolicy } from "@openclaw/ai/diagnostics";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

const REDACTED_MEDIA_DATA = "<redacted>";

const CORE_DIAGNOSTIC_PROJECTION = {
  omitField: (key) => key === "providerReplay",
  propertyScope: "enumerable",
  projectBinary: (binary) => ({
    redacted: REDACTED_MEDIA_DATA,
    bytes: binary.byteLength,
    sha256: sha256Hex(binary),
  }),
  projectMedia: (key, media) => ({
    [key]: REDACTED_MEDIA_DATA,
    ...(media.source === undefined ? {} : { bytes: media.bytes, sha256: sha256Hex(media.source) }),
  }),
} satisfies DiagnosticProjectionPolicy;

/** Removes credentials and inline media bytes from diagnostic payloads before persistence. */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  return projectDiagnosticValue(value, CORE_DIAGNOSTIC_PROJECTION);
}
