// Leaf contract shared by write-time schema validation and resolve-time data reads.
// Kept dependency-free so schema.ts and data-read.ts never import each other.
import path from "node:path";

export const DATA_READ_RPC_ALLOWLIST = [
  "health",
  "system-presence",
  "usage.status",
  "usage.cost",
  "agents.list",
  "sessions.list",
  "sessions.resolve",
  "sessions.get",
  "sessions.usage",
  "sessions.usage.timeseries",
  "sessions.usage.logs",
  "node.list",
  "node.describe",
  "cron.get",
  "cron.list",
  "cron.status",
  "cron.runs",
] as const;

/** Gateway events that stream bindings may consume over the existing UI socket. */
export const STREAM_EVENT_ALLOWLIST = ["presence", "sessions.changed"] as const;

/** Fixed client-side operations available to computed bindings. */
export const COMPUTED_OPS = [
  "sum",
  "avg",
  "min",
  "max",
  "last",
  "count",
  "pick",
  "format",
] as const;

export type ComputedOp = (typeof COMPUTED_OPS)[number];

/** Server-owned capabilities returned with `workspaces.get` for fail-closed UI use. */
export const WORKSPACE_BINDING_CONTRACT = {
  streamEvents: STREAM_EVENT_ALLOWLIST,
  computedOps: COMPUTED_OPS,
} as const;

type WorkspaceBindingErrorCode =
  | "binding_denied"
  | "binding_not_found"
  | "binding_too_large"
  | "binding_invalid"
  | "binding_client_resolved";

export class WorkspaceBindingResolutionError extends Error {
  constructor(
    readonly code: WorkspaceBindingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceBindingResolutionError";
  }
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function normalizeWorkspaceDataLogicalPath(value: string): string {
  if (
    value.startsWith("/") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    hasControlCharacter(value)
  ) {
    throw new WorkspaceBindingResolutionError("binding_invalid", "file binding path is invalid");
  }
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts[0] === "~" ||
    parts.some((part) => part === "." || part === ".." || part.includes(":"))
  ) {
    throw new WorkspaceBindingResolutionError("binding_invalid", "file binding path is invalid");
  }
  return parts.join("/");
}
