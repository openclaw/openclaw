// Matrix plugin module implements to-device compatibility normalization.
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";

const KEY_VERIFICATION_ACCEPT_TYPE = "m.key.verification.accept";
const MATRIX_SAS_VERIFICATION_METHOD = VerificationMethod.Sas;
const MATRIX_TO_DEVICE_COMPAT_PATCHED = Symbol("openclaw-matrix-to-device-compat-patched");

type MatrixToDeviceEvent = {
  content?: unknown;
  type?: unknown;
  [key: string]: unknown;
};

type MatrixToDeviceCompatResult = {
  events: unknown[];
  normalizedAcceptEvents: number;
};

type MatrixRustCryptoBackendPreprocessor = {
  preprocessToDeviceMessages?: (events: unknown[]) => Promise<unknown[]>;
  [MATRIX_TO_DEVICE_COMPAT_PATCHED]?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVerificationAcceptEvent(event: MatrixToDeviceEvent): {
  event: MatrixToDeviceEvent;
  normalized: boolean;
} {
  if (event.type !== KEY_VERIFICATION_ACCEPT_TYPE || !isRecord(event.content)) {
    return { event, normalized: false };
  }
  const method = event.content.method;
  if (typeof method === "string" && method.trim().length > 0) {
    return { event, normalized: false };
  }
  return {
    event: {
      ...event,
      content: {
        ...event.content,
        method: MATRIX_SAS_VERIFICATION_METHOD,
      },
    },
    normalized: true,
  };
}

function normalizeMatrixToDeviceEventsForRustCrypto(events: unknown[]): MatrixToDeviceCompatResult {
  let normalizedAcceptEvents = 0;
  const normalizedEvents = events.map((event) => {
    if (!isRecord(event)) {
      return event;
    }
    const normalized = normalizeVerificationAcceptEvent(event);
    if (normalized.normalized) {
      normalizedAcceptEvents += 1;
    }
    return normalized.event;
  });
  return {
    events: normalizedAcceptEvents > 0 ? normalizedEvents : events,
    normalizedAcceptEvents,
  };
}

export function patchMatrixRustCryptoToDeviceCompatibility(params: {
  client: unknown;
  onNormalizedAcceptEvents?: (count: number) => void;
}): void {
  // matrix-js-sdk sends /sync to-device events into Rust crypto before JS MatrixEvent
  // compatibility hooks run, so Element's missing SAS method must be fixed at this boundary.
  if (!isRecord(params.client) || !isRecord(params.client.cryptoBackend)) {
    return;
  }
  const backend = params.client.cryptoBackend as MatrixRustCryptoBackendPreprocessor;
  const original = backend.preprocessToDeviceMessages;
  if (typeof original !== "function" || backend[MATRIX_TO_DEVICE_COMPAT_PATCHED]) {
    return;
  }
  backend[MATRIX_TO_DEVICE_COMPAT_PATCHED] = true;
  backend.preprocessToDeviceMessages = async (events) => {
    const normalized = normalizeMatrixToDeviceEventsForRustCrypto(events);
    if (normalized.normalizedAcceptEvents > 0) {
      params.onNormalizedAcceptEvents?.(normalized.normalizedAcceptEvents);
    }
    return await original.call(backend, normalized.events);
  };
}
