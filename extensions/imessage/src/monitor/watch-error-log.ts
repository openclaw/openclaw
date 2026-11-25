import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeIMessageFullDiskAccessError } from "../process-diagnostics.js";

type SanitizedIMessageWatchErrorPayload = {
  code?: number;
  message?: string;
};

export function sanitizeIMessageWatchErrorPayload(
  payload: unknown,
): SanitizedIMessageWatchErrorPayload {
  if (!isRecord(payload)) {
    return {};
  }

  const safe: SanitizedIMessageWatchErrorPayload = {};

  if (typeof payload.code === "number" && Number.isFinite(payload.code)) {
    safe.code = payload.code;
  }

  if (typeof payload.message === "string") {
    const guidance = normalizeIMessageFullDiskAccessError(payload.message);
    if (guidance) {
      safe.message = guidance;
    }
  }

  return safe;
}
