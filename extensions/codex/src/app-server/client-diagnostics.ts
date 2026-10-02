import { randomUUID } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";
import type { CodexAppServerTransport } from "./transport.js";

const CODEX_APP_SERVER_CLIENT_INSTANCE_IDS = new WeakMap<object, string>();

/** Process-local generation fence for bindings tied to one app-server client instance. */
export function getCodexAppServerClientInstanceId(client: object): string {
  const current = CODEX_APP_SERVER_CLIENT_INSTANCE_IDS.get(client);
  if (current) {
    return current;
  }
  const created = randomUUID();
  CODEX_APP_SERVER_CLIENT_INSTANCE_IDS.set(client, created);
  return created;
}

export function resolveCodexAppServerClientInstanceId(client: object): string {
  // SAFETY: Existing client contracts expose an optional accessor; preserve its receiver and fallback.
  const getInstanceId = (client as { getInstanceId?: () => string }).getInstanceId;
  return getInstanceId?.call(client) ?? getCodexAppServerClientInstanceId(client);
}

export function observeCodexAppServerStderr(
  stderr: CodexAppServerTransport["stderr"],
  consume: (chunk: string) => string,
): void {
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    const text = consume(chunk).trim();
    if (text) {
      embeddedAgentLog.debug(`codex app-server stderr: ${text}`);
    }
  });
  // Diagnostic stream failure does not invalidate the JSON-RPC stdout connection.
  stderr.on("error", (error) =>
    embeddedAgentLog.warn("codex app-server stderr stream failed", { error }),
  );
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
