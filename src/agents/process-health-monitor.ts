import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/process-health");

export type ProcessHealthStatus = "ok" | "stalled" | "dead";

export type ProcessHealthIssue = {
  sessionId: string;
  status: ProcessHealthStatus;
  pid?: number;
  command?: string;
  scopeKey?: string;
  sessionKey?: string;
  startedAt?: number;
  lastOutputAt?: number;
  reason: string;
};

export type ProcessHealthReport = {
  checkedAt: number;
  issues: ProcessHealthIssue[];
};

export type MonitoredProcessSession = {
  id: string;
  command?: string;
  scopeKey?: string;
  sessionKey?: string;
  pid?: number;
  startedAt?: number;
  backgrounded?: boolean;
  exited?: boolean;
};

type SessionSidecar = {
  lastOutputAt: number;
  lastSeenAliveAt: number;
  exitObserved?: boolean;
};

const sidecar = new Map<string, SessionSidecar>();

let stallMs = Number.parseInt(process.env.PI_BASH_STALL_MS ?? "", 10);
if (!Number.isFinite(stallMs) || stallMs <= 0) {
  stallMs = 5 * 60_000;
}

let crashLoopWindowMs = Number.parseInt(process.env.PI_BASH_CRASH_LOOP_WINDOW_MS ?? "", 10);
if (!Number.isFinite(crashLoopWindowMs) || crashLoopWindowMs <= 0) {
  crashLoopWindowMs = 2 * 60_000;
}

let crashLoopMaxRestarts = Number.parseInt(process.env.PI_BASH_CRASH_LOOP_MAX_RESTARTS ?? "", 10);
if (!Number.isFinite(crashLoopMaxRestarts) || crashLoopMaxRestarts <= 0) {
  crashLoopMaxRestarts = 3;
}

type CrashLoopKey = string;
const crashLoops = new Map<CrashLoopKey, { restarts: number[] }>();

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 does not actually kill the process; it checks liveness/permissions.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function crashLoopKeyFor(session: MonitoredProcessSession): CrashLoopKey {
  const scope = session.scopeKey ?? "";
  const cmd = session.command ?? "";
  return `${scope}::${cmd}`;
}

function noteRestart(session: MonitoredProcessSession) {
  const key = crashLoopKeyFor(session);
  const now = Date.now();
  const entry = crashLoops.get(key) ?? { restarts: [] };
  entry.restarts = entry.restarts.filter((t) => now - t <= crashLoopWindowMs);
  entry.restarts.push(now);
  crashLoops.set(key, entry);
}

export function noteProcessSessionAdded(session: MonitoredProcessSession) {
  sidecar.set(session.id, {
    lastOutputAt: Date.now(),
    lastSeenAliveAt: Date.now(),
  });
  noteRestart(session);
}

export function noteProcessSessionOutput(session: MonitoredProcessSession) {
  const entry = sidecar.get(session.id);
  const now = Date.now();
  if (entry) {
    entry.lastOutputAt = now;
    entry.lastSeenAliveAt = now;
    return;
  }
  sidecar.set(session.id, { lastOutputAt: now, lastSeenAliveAt: now });
}

export function noteProcessSessionExited(sessionId: string) {
  const entry = sidecar.get(sessionId);
  if (entry) {
    entry.exitObserved = true;
  }
}

export function forgetProcessSession(sessionId: string) {
  sidecar.delete(sessionId);
}

export function checkProcessSessions(sessions: MonitoredProcessSession[]): ProcessHealthReport {
  const now = Date.now();
  const issues: ProcessHealthIssue[] = [];

  for (const session of sessions) {
    if (!session.backgrounded || session.exited) {
      continue;
    }
    const pid = session.pid;
    const alive = typeof pid === "number" ? isPidAlive(pid) : true;
    const s = sidecar.get(session.id);
    const lastOutputAt = s?.lastOutputAt;

    if (typeof pid === "number" && !alive) {
      issues.push({
        sessionId: session.id,
        status: "dead",
        pid,
        command: session.command,
        scopeKey: session.scopeKey,
        sessionKey: session.sessionKey,
        startedAt: session.startedAt,
        lastOutputAt,
        reason: "pid not alive",
      });
      continue;
    }

    if (lastOutputAt && now - lastOutputAt > stallMs) {
      issues.push({
        sessionId: session.id,
        status: "stalled",
        pid,
        command: session.command,
        scopeKey: session.scopeKey,
        sessionKey: session.sessionKey,
        startedAt: session.startedAt,
        lastOutputAt,
        reason: `no output for ${Math.round((now - lastOutputAt) / 1000)}s`,
      });
    }

    const crashKey = crashLoopKeyFor(session);
    const loop = crashLoops.get(crashKey);
    if (loop) {
      const recent = loop.restarts.filter((t) => now - t <= crashLoopWindowMs);
      if (recent.length >= crashLoopMaxRestarts) {
        issues.push({
          sessionId: session.id,
          status: "stalled",
          pid,
          command: session.command,
          scopeKey: session.scopeKey,
          sessionKey: session.sessionKey,
          startedAt: session.startedAt,
          lastOutputAt,
          reason: `possible crash loop: ${recent.length} starts in ${Math.round(crashLoopWindowMs / 1000)}s`,
        });
      }
    }
  }

  return { checkedAt: now, issues };
}

let poller: NodeJS.Timeout | null = null;
let pollerActive = false;

export function startProcessHealthPoller(params: {
  /** Callable that returns current running sessions. */
  listSessions: () => MonitoredProcessSession[];
  intervalMs?: number;
  onReport?: (report: ProcessHealthReport) => void;
}) {
  if (poller) {
    return;
  }
  const intervalMs =
    typeof params.intervalMs === "number" &&
    Number.isFinite(params.intervalMs) &&
    params.intervalMs > 0
      ? Math.max(1_000, Math.floor(params.intervalMs))
      : 30_000;

  pollerActive = true;
  poller = setInterval(() => {
    if (!pollerActive) {
      return;
    }
    try {
      const report = checkProcessSessions(params.listSessions());
      if (report.issues.length > 0) {
        log.warn?.(
          `[process-health] issues=${report.issues.length} sample=${report.issues[0]?.reason ?? "unknown"}`,
        );
      }
      params.onReport?.(report);
    } catch (err) {
      log.warn?.(
        `[process-health] poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, intervalMs);
  poller.unref?.();
}

export function stopProcessHealthPoller() {
  pollerActive = false;
  if (!poller) {
    return;
  }
  clearInterval(poller);
  poller = null;
}
