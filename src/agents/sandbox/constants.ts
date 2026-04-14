import path from "node:path";
import { CHANNEL_IDS } from "../../channels/ids.js";
import { STATE_DIR } from "../../config/paths.js";

export const DEFAULT_SANDBOX_WORKSPACE_ROOT = path.join(STATE_DIR, "sandboxes");

export const DEFAULT_SANDBOX_IMAGE = "openclaw-sandbox:bookworm-slim";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "openclaw-sbx-";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_IDLE_HOURS = 24;
export const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;

export const DEFAULT_TOOL_ALLOW = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "image",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "session_status",
] as const;

// Provider docking: keep sandbox policy aligned with provider tool names.
export const DEFAULT_TOOL_DENY = [
  "browser",
  "canvas",
  "nodes",
  "cron",
  "gateway",
  ...CHANNEL_IDS,
] as const;

export const DEFAULT_SANDBOX_BROWSER_IMAGE = "openclaw-sandbox-browser:bookworm-slim";
export const DEFAULT_SANDBOX_COMMON_IMAGE = "openclaw-sandbox-common:bookworm-slim";
export const SANDBOX_BROWSER_SECURITY_HASH_EPOCH = "2026-04-05-cdp-source-range";

export const DEFAULT_SANDBOX_BROWSER_PREFIX = "openclaw-sbx-browser-";
export const DEFAULT_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";
export const DEFAULT_SANDBOX_BROWSER_CDP_PORT = 9222;
export const DEFAULT_SANDBOX_BROWSER_VNC_PORT = 5900;
export const DEFAULT_SANDBOX_BROWSER_NOVNC_PORT = 6080;
export const DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS = 12_000;

/**
 * Default init timeout for local (Docker) sandbox backends.
 * 60s is generous for a warm container start but short enough to unblock the
 * message pipeline when Docker is hung or unreachable.
 */
export const DEFAULT_SANDBOX_INIT_TIMEOUT_MS = 60_000;

/**
 * Default init timeout for remote (SSH/OpenShell) sandbox backends.
 * Remote backends may need to seed workspaces, run setup commands, or transfer
 * files over the network, so they get a larger budget by default.
 */
export const DEFAULT_SANDBOX_REMOTE_INIT_TIMEOUT_MS = 300_000;

export const SANDBOX_AGENT_WORKSPACE_MOUNT = "/agent";

export const SANDBOX_STATE_DIR = path.join(STATE_DIR, "sandbox");
export const SANDBOX_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "containers.json");
export const SANDBOX_BROWSER_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "browsers.json");
