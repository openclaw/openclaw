import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export class IsolationIdentityError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IsolationIdentityError";
  }
}

type FallbackPolicy = "deny" | "session" | "agent";

const RESERVED_SEGMENTS = new Set(["group", "channel", "dm", "cron", "subagent", "acp"]);

export function isMemoryIsolationEnabled(cfg: OpenClawConfig | undefined): boolean {
  return readIsolation(cfg)?.enabled === true;
}

function readIsolation(cfg: OpenClawConfig | undefined): {
  enabled: boolean;
  fallbackPolicy: FallbackPolicy;
} | null {
  const memory = (cfg as { memory?: { isolation?: Record<string, unknown> } } | undefined)?.memory;
  const iso = memory?.isolation;
  if (!iso) {
    return null;
  }
  const enabled = iso.enabled !== false;
  if (!enabled) {
    return { enabled: false, fallbackPolicy: "deny" };
  }
  const raw = iso.fallbackPolicy;
  const fallbackPolicy: FallbackPolicy = raw === "session" || raw === "agent" ? raw : "deny";
  return { enabled, fallbackPolicy };
}

function extractDirectUserId(sessionKey: string | undefined): string | null {
  if (!sessionKey) {
    return null;
  }
  const parts = sessionKey.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }
  const directIdx = parts.indexOf("direct", 2);
  if (directIdx === -1 || directIdx + 1 >= parts.length) {
    return null;
  }
  const candidate = parts[directIdx + 1];
  if (!candidate || RESERVED_SEGMENTS.has(candidate)) {
    return null;
  }
  return candidate;
}

export function resolveIsolationIdentity(opts: {
  cfg: OpenClawConfig | undefined;
  agentId: string;
  sessionKey?: string;
  senderId?: string;
}): string | undefined {
  const policy = readIsolation(opts.cfg);
  if (!policy || !policy.enabled) {
    return undefined;
  }
  const sender = typeof opts.senderId === "string" ? opts.senderId.trim() : "";
  if (sender) {
    return sender;
  }
  const fromKey = extractDirectUserId(opts.sessionKey);
  if (fromKey) {
    return fromKey;
  }
  switch (policy.fallbackPolicy) {
    case "session":
      if (!opts.sessionKey) {
        throw new IsolationIdentityError("session fallback requested but sessionKey is missing");
      }
      return `session:${opts.sessionKey}`;
    case "agent":
      return `agent:${opts.agentId}`;
    case "deny":
    default:
      throw new IsolationIdentityError(
        "memory isolation enabled but no user identity could be resolved (sender/session)",
      );
  }
}
