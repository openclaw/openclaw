import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";

const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|user_removed_from_team|team_disabled|missing_scope|cannot_find_service|invalid_token/i;

// Slack can emit an isolated invalid_auth while the credentials still pass
// auth.test, so only the remainder proves a dead credential or account.
const SLACK_DEFINITIVE_AUTH_ERROR_RE =
  /account_inactive|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|user_removed_from_team|team_disabled|missing_scope|cannot_find_service|invalid_token/i;

/** Consecutive isolated invalid_auth failures before the channel turns terminal. */
export const SLACK_ISOLATED_INVALID_AUTH_TERMINAL_LIMIT = 3;

export const SLACK_SOCKET_RECONNECT_POLICY = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
} as const;

type SlackSocketDisconnectEvent = "disconnect" | "unable_to_socket_mode_start";

type EmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL =
  "https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections";
const SLACK_SOCKET_HELLO_MARKER = Buffer.from('"hello"');

function isBufferArray(value: unknown): value is Buffer[] {
  return Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry));
}

function resolveSlackSocketModeConnectionCount(message: unknown): number | undefined {
  const buffer =
    typeof message === "string"
      ? Buffer.from(message)
      : Buffer.isBuffer(message)
        ? message
        : message instanceof ArrayBuffer
          ? Buffer.from(message)
          : isBufferArray(message)
            ? Buffer.concat(message)
            : undefined;
  if (!buffer?.includes(SLACK_SOCKET_HELLO_MARKER)) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
  const count = isRecord(payload) && payload.type === "hello" ? payload.num_connections : undefined;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function formatSlackSocketModeSharedConnectionWarning(activeConnections: number): string {
  return [
    `slack socket mode reports ${activeConnections} active connections for this Slack app`,
    "Slack may deliver each event to any one connection",
    "check that every OpenClaw gateway sharing this app has equivalent routing and authorization, or use a separate Slack app per gateway, one relay ingress, or HTTP Request URLs behind a load balancer",
    `See ${SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL}`,
  ].join("; ");
}

export function registerSlackSocketModeConnectionDiagnostics(params: {
  client: EmitterLike;
  onSharedConnection: (activeConnections: number) => void;
}): () => void {
  const emitter = params.client;
  let hasWarned = false;
  const listener = (message: unknown, isBinary?: unknown) => {
    if (isBinary === true || hasWarned) {
      return;
    }
    const activeConnections = resolveSlackSocketModeConnectionCount(message);
    if (activeConnections === undefined || activeConnections <= 1) {
      return;
    }
    hasWarned = true;
    params.onSharedConnection(activeConnections);
  };
  emitter.on("ws_message", listener);
  return () => {
    emitter.off("ws_message", listener);
  };
}

export function waitForSlackSocketDisconnect(
  emitter: EmitterLike,
  abortSignal?: AbortSignal,
): Promise<{
  event: SlackSocketDisconnectEvent;
  error?: unknown;
}> {
  return new Promise((resolve) => {
    const disconnectListener = () => resolveOnce({ event: "disconnect" });
    const startFailListener = (error?: unknown) =>
      resolveOnce({ event: "unable_to_socket_mode_start", error });
    const abortListener = () => resolveOnce({ event: "disconnect" });

    const cleanup = () => {
      emitter.off("disconnected", disconnectListener);
      emitter.off("unable_to_socket_mode_start", startFailListener);
      abortSignal?.removeEventListener("abort", abortListener);
    };

    const resolveOnce = (value: { event: SlackSocketDisconnectEvent; error?: unknown }) => {
      cleanup();
      resolve(value);
    };

    emitter.on("disconnected", disconnectListener);
    emitter.on("unable_to_socket_mode_start", startFailListener);
    abortSignal?.addEventListener("abort", abortListener, { once: true });
  });
}

/**
 * Detect permanent Slack account and credential failures.
 * Transient request and HTTP failures stay in OpenClaw's reconnect loop.
 */
export function isNonRecoverableSlackAuthError(error: unknown): boolean {
  return SLACK_AUTH_ERROR_RE.test(formatSlackError(error, ""));
}

/** Terminal, retryable-isolated, or undefined (not auth-shaped) for this failure. */
export function nextSlackAuthFailureState(
  error: unknown,
  consecutiveInvalidAuth: number,
): { decision: "terminal" | "retry-isolated" | undefined; consecutiveInvalidAuth: number } {
  if (error && isIsolatedInvalidAuthSlackError(error)) {
    const next = consecutiveInvalidAuth + 1;
    return next >= SLACK_ISOLATED_INVALID_AUTH_TERMINAL_LIMIT
      ? { decision: "terminal", consecutiveInvalidAuth: next }
      : { decision: "retry-isolated", consecutiveInvalidAuth: next };
  }
  return {
    decision: error && isNonRecoverableSlackAuthError(error) ? "terminal" : undefined,
    consecutiveInvalidAuth,
  };
}

/** Isolated invalid_auth: auth-shaped, but not a definitive credential verdict. */
export function isIsolatedInvalidAuthSlackError(error: unknown): boolean {
  const text = formatSlackError(error, "");
  return /invalid_auth/i.test(text) && !SLACK_DEFINITIVE_AUTH_ERROR_RE.test(text);
}
