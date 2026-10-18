import { formatErrorMessage, readErrorName } from "../../../infra/errors.js";

export function buildSafeLifecycleErrorMeta(error: unknown): Record<string, string> {
  const message = formatErrorMessage(error);
  const name = readErrorName(error);
  return name ? { name, message } : { message };
}
