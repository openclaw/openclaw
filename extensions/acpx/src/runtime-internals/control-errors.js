import {
  asOptionalBoolean,
  asOptionalString,
  asTrimmedString,
  isRecord
} from "./shared.js";
function parseControlJsonError(value) {
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
    code: typeof codeValue === "number" && Number.isFinite(codeValue) ? String(codeValue) : asOptionalString(codeValue),
    retryable: asOptionalBoolean(error.retryable)
  };
}
export {
  parseControlJsonError
};
