import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";

export function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = `${current}${next}`;
  return combined.length > maxLength ? sliceUtf16Safe(combined, -maxLength) : combined;
}

export function buildCodexAppServerExitError(
  code: unknown,
  signal: unknown,
  stderrTail: string,
): Error {
  const stderrPreview = redactCodexAppServerLinePreview(stderrTail);
  const suffix = stderrPreview ? ` stderr=${JSON.stringify(stderrPreview)}` : "";
  return new Error(
    `codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(
      signal,
    )}${suffix}`,
  );
}

export function logCodexAppServerParseFailure(
  value: string,
  error: unknown,
  fragmentCount: number,
): void {
  const linePreview = redactCodexAppServerLinePreview(value);
  const suffix = fragmentCount > 1 ? ` fragments=${fragmentCount}` : "";
  embeddedAgentLog.warn("failed to parse codex app-server message", {
    error,
    errorMessage: coerceErrorMessage(error),
    fragmentCount,
    linePreview,
    consoleMessage: `failed to parse codex app-server message${suffix}: preview=${JSON.stringify(
      linePreview,
    )}`,
  });
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "unknown";
}
