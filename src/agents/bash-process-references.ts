/**
 * Compact references for active background bash sessions.
 * These references are surfaced in agent context so follow-up turns can
 * reconnect to prior long-running work.
 */
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { compareProcessSessionStartOrder, listRunningSessions } from "./bash-process-registry.js";
import { deriveSessionName } from "./bash-tools.shared.js";

const DEFAULT_ACTIVE_PROCESS_LIMIT = 8;
const MAX_COMMAND_LABEL_CHARS = 140;

/** Agent-facing summary of a reconnectable background process session. */
export type ActiveProcessSessionReference = {
  sessionId: string;
  status: "running";
  pid?: number;
  startedAt: number;
  runtimeMs: number;
  cwd?: string;
  command: string;
  name: string;
  tail?: string;
  truncated: boolean;
};

/** List active background process sessions for one scope key, newest first. */
export function listActiveProcessSessionReferences(params: {
  scopeKey?: string;
  now?: number;
  limit?: number;
}): ActiveProcessSessionReference[] {
  const scopeKey = params.scopeKey?.trim();
  if (!scopeKey) {
    return [];
  }
  const now = params.now ?? Date.now();
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : DEFAULT_ACTIVE_PROCESS_LIMIT;
  return listRunningSessions()
    .filter((session) => session.scopeKey === scopeKey)
    .toSorted(compareProcessSessionStartOrder)
    .slice(0, limit)
    .map((session) => ({
      sessionId: session.id,
      status: "running" as const,
      pid: session.pid,
      startedAt: session.startedAt,
      runtimeMs: Math.max(0, now - session.startedAt),
      cwd: session.cwd,
      command: session.command,
      name: truncateWithMarker(
        deriveSessionName(session.command) || session.command,
        MAX_COMMAND_LABEL_CHARS,
        { marker: "...", reserve: 3, trimEnd: false },
      ),
      tail: session.tail,
      truncated: session.truncated,
    }));
}
