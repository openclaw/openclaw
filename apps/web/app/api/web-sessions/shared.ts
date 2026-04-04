import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveActiveAgentId, resolveWebChatDir } from "@/lib/workspace";

export type WebSessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** When set, this session is scoped to a specific workspace file. */
  filePath?: string;
  /** Workspace name at session creation time (pinned). */
  workspaceName?: string;
  /** Workspace root directory at session creation time. */
  workspaceRoot?: string;
  /** The workspace's durable agent ID (e.g. "main"). */
  workspaceAgentId?: string;
  /** Ephemeral chat-specific agent ID, if one was allocated. */
  chatAgentId?: string;
  /** The full gateway session key used for this chat. */
  gatewaySessionKey?: string;
  /**
   * Optional gateway thread id (suffix of `agent:{agentId}:web:{id}`).
   * When unset, the web session `id` is used. Rotating this gives the gateway a
   * fresh context without changing the web chat id or transcript file.
   */
  gatewaySessionId?: string;
  /** Which agent model is in use: "workspace" (shared) or "ephemeral" (per-chat). */
  agentMode?: "workspace" | "ephemeral";
  /** Last time the session had active traffic. */
  lastActiveAt?: number;
};

export function ensureDir() {
  const dir = resolveWebChatDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read the session index, auto-discovering any orphaned .jsonl files
 * that aren't in the index (e.g. from profile switches or missing index).
 */
export function readIndex(): WebSessionMeta[] {
  const dir = ensureDir();
  const indexFile = join(dir, "index.json");
  let index: WebSessionMeta[] = [];
  if (existsSync(indexFile)) {
    try {
      index = JSON.parse(readFileSync(indexFile, "utf-8"));
    } catch {
      index = [];
    }
  }

  // Scan for orphaned .jsonl files not in the index
  try {
    const indexed = new Set(index.map((s) => s.id));
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    let dirty = false;
    for (const file of files) {
      const id = file.replace(/\.jsonl$/, "");
      if (indexed.has(id)) {continue;}

      const fp = join(dir, file);
      const stat = statSync(fp);
      let title = "New Chat";
      let messageCount = 0;
      try {
        const content = readFileSync(fp, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        messageCount = lines.length;
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.role === "user" && parsed.content) {
            const text = String(parsed.content);
            title = text.length > 60 ? text.slice(0, 60) + "..." : text;
            break;
          }
        }
      } catch { /* best-effort */ }

      index.push({
        id,
        title,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        messageCount,
      });
      dirty = true;
    }

    if (dirty) {
      index.sort((a, b) => b.updatedAt - a.updatedAt);
      writeFileSync(indexFile, JSON.stringify(index, null, 2));
    }
  } catch { /* best-effort */ }

  return index;
}

export function writeIndex(sessions: WebSessionMeta[]) {
  const dir = ensureDir();
  writeFileSync(join(dir, "index.json"), JSON.stringify(sessions, null, 2));
}

/** Look up a session's pinned metadata by ID. Returns undefined for unknown sessions. */
export function getSessionMeta(sessionId: string): WebSessionMeta | undefined {
  return readIndex().find((s) => s.id === sessionId);
}

/** Resolve the effective agent ID for a session.
 *  Uses pinned metadata when available, falls back to workspace-global resolution. */
export function resolveSessionAgentId(sessionId: string, fallbackAgentId: string): string {
  const meta = getSessionMeta(sessionId);
  return meta?.workspaceAgentId ?? fallbackAgentId;
}

/** Effective gateway thread id (defaults to the web session id). */
export function resolveGatewayThreadId(sessionId: string): string {
  const meta = getSessionMeta(sessionId);
  return meta?.gatewaySessionId ?? sessionId;
}

/** True when the gateway thread was rotated away from the web session id (fresh gateway context). */
export function hasRotatedGatewayThread(meta: WebSessionMeta | undefined, webSessionId: string): boolean {
  return typeof meta?.gatewaySessionId === "string" && meta.gatewaySessionId !== webSessionId;
}

/** Allocate a new gateway thread id and persist it (same web chat id and transcript path). */
export function rotateGatewaySessionThreadForModelReset(webSessionId: string): void {
  const sessions = readIndex();
  const session = sessions.find((s) => s.id === webSessionId);
  if (!session) {
    return;
  }
  const agentId = session.workspaceAgentId ?? resolveActiveAgentId();
  const newThreadId = randomUUID();
  session.gatewaySessionId = newThreadId;
  session.gatewaySessionKey = `agent:${agentId}:web:${newThreadId}`;
  session.updatedAt = Date.now();
  writeIndex(sessions);
}

/** Resolve the gateway session key for a session. */
export function resolveSessionKey(sessionId: string, fallbackAgentId: string): string {
  const meta = getSessionMeta(sessionId);
  const agentId = meta?.workspaceAgentId ?? fallbackAgentId;
  const threadId = meta?.gatewaySessionId ?? sessionId;
  return `agent:${agentId}:web:${threadId}`;
}
