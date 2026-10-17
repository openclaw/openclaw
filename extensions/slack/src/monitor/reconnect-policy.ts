import { warn } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";

const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|user_removed_from_team|team_disabled|missing_scope|cannot_find_service|invalid_token/i;

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
const SLACK_SOCKET_DISCONNECT_MARKER = Buffer.from('"disconnect"');

type SlackSocketModeControlFrame =
  | { type: "hello"; numConnections: number }
  | { type: "disconnect"; reason: string };

function isBufferArray(value: unknown): value is Buffer[] {
  return Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry));
}

export function resolveSlackSocketModeControlFrame(
  message: unknown,
): SlackSocketModeControlFrame | undefined {
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
  if (
    !buffer ||
    (!buffer.includes(SLACK_SOCKET_HELLO_MARKER) &&
      !buffer.includes(SLACK_SOCKET_DISCONNECT_MARKER))
  ) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload.type === "hello") {
    const count = payload.num_connections;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? { type: "hello", numConnections: count }
      : undefined;
  }
  if (payload.type === "disconnect" && typeof payload.reason === "string") {
    return { type: "disconnect", reason: payload.reason };
  }
  return undefined;
}

function formatSlackSocketModeSharedConnectionWarning(activeConnections: number): string {
  return [
    `slack socket mode reports ${activeConnections} active connections for this Slack app`,
    "Slack may deliver each event to any one connection",
    "check that every OpenClaw gateway sharing this app has equivalent routing and authorization, or use a separate Slack app per gateway, one relay ingress, or HTTP Request URLs behind a load balancer",
    `See ${SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL}`,
  ].join("; ");
}

export function registerSlackSocketModeConnectionDiagnostics(params: {
  client: EmitterLike;
  accountId: string;
  log?: (message: string) => void;
}): () => void {
  const emitter = params.client;
  let hasWarned = false;
  const listener = (message: unknown, isBinary?: unknown) => {
    if (isBinary === true) {
      return;
    }
    const frame = resolveSlackSocketModeControlFrame(message);
    const activeConnections = frame?.type === "hello" ? frame.numConnections : undefined;
    if (activeConnections === undefined || activeConnections <= 1) {
      return;
    }
    if (hasWarned) {
      // Slack keeps counting connections that are gone, so later hellos stay visible too.
      params.log?.(
        `[${params.accountId}] slack socket mode reconnected; Slack reports ${activeConnections} active connections for this Slack app`,
      );
      return;
    }
    hasWarned = true;
    params.log?.(
      warn(
        `[${params.accountId}] ${formatSlackSocketModeSharedConnectionWarning(activeConnections)}`,
      ),
    );
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
