import {
  asOptionalBoolean,
  asOptionalString,
  asTrimmedString,
  type AcpxErrorEvent,
  isRecord,
} from "./shared.js";

export function parseControlJsonError(value: unknown): AcpxErrorEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const error = isRecord(value.error) ? value.error : null;
  if (!error) {
    return null;
  }
  const message = asTrimmedString(error.message) || "acpx reported an error";
  const codeValue = error.code;
  return {
    message,
    code:
      typeof codeValue === "number" && Number.isFinite(codeValue)
        ? String(codeValue)
        : asOptionalString(codeValue),
    retryable: asOptionalBoolean(error.retryable),
  };
}
