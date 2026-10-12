import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage, readErrorName } from "../../../infra/errors.js";

export function buildSafeLifecycleErrorMeta(error: unknown): Record<string, string> {
  const message = formatErrorMessage(error);
  const name = readErrorName(error);
  return name ? { name, message } : { message };
}

export function maskLifecycleIdentifier(value: string, kind: "run" | "session"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  return kind === "session"
    ? `${trimmed.split(":").slice(0, 2).join(":") || "session"}:…`
    : trimmed.length <= 8
      ? "***"
      : `${sliceUtf16Safe(trimmed, 0, 4)}…${sliceUtf16Safe(trimmed, -4)}`;
}
