/**
 * Shared gateway client identity contract.
 *
 * These values cross the WebSocket handshake boundary, so additions must stay
 * aligned with protocol schemas and server policy checks.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/** Canonical client ids accepted in gateway hello/connect payloads. */
export const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  BROWSER_COPILOT: "openclaw-browser-copilot",
  TUI: "openclaw-tui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  // Native Linux UI uses the same trusted-client admission class as the macOS app.
  LINUX_APP: "openclaw-linux",
  IOS_APP: "openclaw-ios",
  WATCHOS_APP: "openclaw-watchos",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  WORKER: "openclaw-worker",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
} as const;

export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];

// Back-compat naming (internal): these values are IDs, not display names.
export const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
/** Compatibility alias for internal callers that still use "name" terminology. */
export type GatewayClientName = GatewayClientId;

/** Coarse modes let policy group clients without matching every product id. */
export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  WORKER: "worker",
  PROBE: "probe",
  TEST: "test",
} as const;

export function isNativeAppUiClient(client?: {
  id?: string | null;
  mode?: string | null;
}): boolean {
  return (
    client?.mode === GATEWAY_CLIENT_MODES.UI &&
    (client.id === GATEWAY_CLIENT_IDS.MACOS_APP ||
      client.id === GATEWAY_CLIENT_IDS.LINUX_APP ||
      client.id === GATEWAY_CLIENT_IDS.IOS_APP ||
      client.id === GATEWAY_CLIENT_IDS.ANDROID_APP)
  );
}

export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

export type GatewayClientInfo = {
  id: GatewayClientId;
  /** Human-readable label for diagnostics; not used for policy decisions. */
  displayName?: string;
  /** Client app or package version reported by the connecting process. */
  version: string;
  /** Exact immutable artifact identity when the client can report one. */
  buildId?: string;
  /** Runtime platform string, such as `darwin`, `ios`, `android`, or `web`. */
  platform: string;
  /** Optional device family used by native clients for display and routing hints. */
  deviceFamily?: string;
  /** Native hardware/model identifier when available. */
  modelIdentifier?: string;
  /** Self-reported IANA time zone, such as `Europe/Vienna`, for presence display. */
  timeZone?: string;
  mode: GatewayClientMode;
  /** Per-installation or per-process id used to distinguish same-product clients. */
  instanceId?: string;
};

/** Capability flags a client may advertise during the gateway handshake. */
export const GATEWAY_CLIENT_CAPS = {
  AGENT_KIND: "agent-kind",
  APPROVALS: "approvals",
  CHAT_ONLY_ASSISTANT_TEXT: "chat-only-assistant-text",
  EXEC_APPROVALS: "exec-approvals",
  HEALTH_SUMMARY: "health-summary",
  HELLO_HEALTH_ON_DEMAND: "hello-health-on-demand",
  HELLO_PRESENCE_SELF: "hello-presence-self",
  INLINE_WIDGETS: "inline-widgets",
  MODEL_CATALOG_SNAPSHOT: "model-catalog-snapshot",
  MODEL_SELECTION_POLICY: "model-selection-policy",
  MODEL_WAIT_STATUS: "model-wait-status",
  RUN_TOOL_BINDINGS: "run-tool-bindings",
  ROSTER_MESSAGE_BODIES_OPTIONAL: "roster-message-bodies-optional",
  SESSION_SCOPED_EVENTS: "session-scoped-events",
  SESSION_ROW_DELTAS: "session-row-deltas",
  SESSION_EVENT_FIELD_REFS: "session-event-field-refs",
  PLUGIN_APPROVALS: "plugin-approvals",
  PRESENCE_DELTAS: "presence-deltas",
  TASK_SUGGESTIONS: "task-suggestions",
  TERMINAL_OFFSET_SEQ: "terminal-offset-seq",
  TERMINAL_SESSION_METADATA: "terminal-session-metadata",
  TERMINAL_UPLOAD_PATH_STYLE: "terminal-upload-path-style",
  TOOL_EVENTS: "tool-events",
  UI_COMMANDS: "ui-commands",
  ULTRAFAST: "ultrafast",
  USAGE_REFRESHING: "usage-refreshing",
} as const;

export type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

const GATEWAY_CLIENT_ID_BY_VALUE = new Map<string, GatewayClientId>(
  Object.values(GATEWAY_CLIENT_IDS).map((value) => [value, value]),
);
const GATEWAY_CLIENT_MODE_BY_VALUE = new Map<string, GatewayClientMode>(
  Object.values(GATEWAY_CLIENT_MODES).map((value) => [value, value]),
);

/** Normalizes untrusted client ids and rejects unknown values. */
export function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined {
  // Handshake input is intentionally case-insensitive, but policy decisions use
  // the canonical lowercase ids from the closed registry above.
  return GATEWAY_CLIENT_ID_BY_VALUE.get(normalizeOptionalLowercaseString(raw) ?? "");
}

/** Normalizes legacy client-name fields through the canonical client-id registry. */
export function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined {
  return normalizeGatewayClientId(raw);
}

/** Normalizes untrusted client modes and rejects unknown values. */
export function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined {
  return GATEWAY_CLIENT_MODE_BY_VALUE.get(normalizeOptionalLowercaseString(raw) ?? "");
}

/** Checks a client-advertised capability list without treating missing caps as errors. */
export function hasGatewayClientCap(
  caps: string[] | null | undefined,
  cap: GatewayClientCap,
): boolean {
  if (!Array.isArray(caps)) {
    return false;
  }
  return caps.includes(cap);
}
