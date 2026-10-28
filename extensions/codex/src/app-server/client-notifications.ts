import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";

const CODEX_APP_SERVER_PENDING_STARTUP_WARNINGS_MAX = 32;

export type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

// Codex exposes no warning codes. Keep complete templates here so changed or
// actionable warnings still reach chat instead of matching a broad substring.
const LOG_ONLY_CODEX_WARNING_PATTERNS = [
  /^Configured service tier `[^`\r\n]+` is not advertised as supported for model `[^`\r\n]+` and will be omitted from requests\.$/,
  /^Code Mode is enabled in configuration, but model `[^`\r\n]+` does not advertise Code Mode support\. This may degrade model performance\. Disable `features\.code_mode` and `features\.code_mode_only`, or select a model whose metadata enables Code Mode\.$/,
];
const CODEX_LOG_WRITE_WARNINGS = new Set([
  "Codex couldn't save diagnostic logs to its local database. Use /feedback with logs included before closing Codex, or run `codex doctor` for diagnostics.",
  "Codex couldn't save diagnostic logs to its local database. Run `codex doctor` for diagnostics.",
]);

export function readCodexAppServerWarningMessage(params: JsonObject): string {
  const summary = readStringField(params, "summary") ?? readStringField(params, "message");
  const details = readStringField(params, "details");
  return [summary, details].filter(Boolean).join("\n");
}

function logCodexAppServerManagedWarning(notification: CodexServerNotification): boolean {
  if (
    (notification.method !== "warning" && notification.method !== "configWarning") ||
    !isJsonObject(notification.params)
  ) {
    return false;
  }
  const message = readCodexAppServerWarningMessage(notification.params);
  // Codex 0.158.0 log_write_warning.rs emits one process-wide warning per reporter.
  // Record it at receipt, before per-turn buffering/fan-out can replay that failure.
  const logWriteFailure =
    notification.method === "warning" &&
    notification.params.threadId === null &&
    CODEX_LOG_WRITE_WARNINGS.has(message);
  if (
    !logWriteFailure &&
    !LOG_ONLY_CODEX_WARNING_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return false;
  }
  try {
    embeddedAgentLog.warn(message);
  } catch {
    // Like the Gateway file logger, diagnostics are best-effort. A failed sink
    // must not turn a valid notification into a shared transport failure.
  }
  return true;
}

export class CodexAppServerNotifications {
  private readonly handlers = new Set<CodexServerNotificationHandler>();
  private readonly pendingStartupWarnings: CodexServerNotification[] = [];

  addHandler(handler: CodexServerNotificationHandler): () => void {
    this.handlers.add(handler);
    // Configuration warnings may precede the first shared turn router.
    for (const notification of this.pendingStartupWarnings.splice(0)) {
      this.dispatch(notification);
    }
    return () => this.handlers.delete(handler);
  }

  dispatch(notification: CodexServerNotification): void {
    if (logCodexAppServerManagedWarning(notification)) {
      return;
    }
    if (this.handlers.size === 0 && notification.method === "configWarning") {
      if (this.pendingStartupWarnings.length === CODEX_APP_SERVER_PENDING_STARTUP_WARNINGS_MAX) {
        this.pendingStartupWarnings.shift();
      }
      this.pendingStartupWarnings.push(notification);
      return;
    }
    for (const handler of this.handlers) {
      try {
        Promise.resolve(handler(notification)).catch((error: unknown) => {
          embeddedAgentLog.warn("codex app-server notification handler failed", { error });
        });
      } catch (error) {
        embeddedAgentLog.warn("codex app-server notification handler failed", { error });
      }
    }
  }
}
