import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";
import type { CodexAppServerParseFailure } from "./client-message-decoder.js";
import type { CodexAppServerTransport } from "./transport.js";

export function observeCodexAppServerStderr(
  stderr: CodexAppServerTransport["stderr"],
  consume: (chunk: string) => void,
): void {
  stderr.setEncoding("utf8");
  stderr.on("data", consume);
  // Diagnostic stream failure does not invalidate the JSON-RPC stdout connection.
  stderr.on("error", () => embeddedAgentLog.warn("codex app-server stderr stream failed"));
}

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

export function logCodexAppServerParseFailure(failure: CodexAppServerParseFailure): void {
  embeddedAgentLog.warn("failed to parse codex app-server message", failure);
}

export function isCodexAppServerBrokenPipeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "EPIPE") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
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
