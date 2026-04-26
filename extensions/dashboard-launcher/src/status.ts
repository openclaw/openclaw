import { readFileSync, statSync } from "node:fs";
import { logPaths } from "./paths.js";
import { isProcessAlive, readIntent, readPid } from "./supervisor.js";

export type Health =
  | { state: "ok" }
  | { state: "unauthorized" }
  | { state: "unreachable"; reason: string }
  | { state: "http_error"; status: number };

export interface DashboardStatus {
  intent: "running" | "stopped";
  pid: number | null;
  pidAlive: boolean;
  uptimeMs: number | null;
  port: number;
  publicMode: boolean;
  health: Health | null;
  logTail: string[];
}

export interface StatusOptions {
  port: number;
  publicMode: boolean;
  authToken?: string;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Probe timeout in ms (default 2_000). */
  probeTimeoutMs?: number;
  /** Number of trailing log lines to include. */
  logTailLines?: number;
}

export async function probeHealth(opts: StatusOptions): Promise<Health> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `http://127.0.0.1:${opts.port}/api/fleet-summary`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.probeTimeoutMs ?? 2000);
  const headers: Record<string, string> = {};
  if (opts.publicMode && opts.authToken) {
    headers.Authorization = `Bearer ${opts.authToken}`;
  }
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers });
    if (res.status === 401 || res.status === 403) {
      return { state: "unauthorized" };
    }
    if (!res.ok) {
      return { state: "http_error", status: res.status };
    }
    return { state: "ok" };
  } catch (err) {
    return { state: "unreachable", reason: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

function readTail(file: string, lines: number): string[] {
  try {
    const raw = readFileSync(file, "utf8");
    const all = raw.split(/\r?\n/);
    while (all.length > 0 && all[all.length - 1] === "") {
      all.pop();
    }
    return all.slice(Math.max(0, all.length - lines));
  } catch {
    return [];
  }
}

export async function status(opts: StatusOptions): Promise<DashboardStatus> {
  const intent = readIntent();
  const pid = readPid();
  const pidAlive = pid != null && isProcessAlive(pid);
  let uptimeMs: number | null = null;
  if (pid != null && pidAlive) {
    try {
      const stat = statSync(`/proc/${pid}`);
      uptimeMs = Date.now() - stat.mtimeMs;
    } catch {
      uptimeMs = null;
    }
  }
  const tail = readTail(logPaths().outLog, opts.logTailLines ?? 5);
  const health = pidAlive ? await probeHealth(opts) : null;
  return {
    intent,
    pid,
    pidAlive,
    uptimeMs,
    port: opts.port,
    publicMode: opts.publicMode,
    health,
    logTail: tail,
  };
}

export function formatStatus(s: DashboardStatus): string {
  const lines: string[] = [];
  lines.push(`dashboard intent: ${s.intent}`);
  lines.push(
    `pid:              ${s.pid ?? "—"} ${s.pid != null ? (s.pidAlive ? "(alive)" : "(dead)") : ""}`.trimEnd(),
  );
  lines.push(`port:             ${s.port}`);
  lines.push(`public mode:      ${s.publicMode ? "yes" : "no"}`);
  lines.push(`health:           ${describeHealth(s.health)}`);
  if (s.logTail.length > 0) {
    lines.push("recent log:");
    for (const line of s.logTail) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

function describeHealth(health: Health | null): string {
  if (!health) {
    return "n/a";
  }
  switch (health.state) {
    case "ok":
      return "healthy";
    case "unauthorized":
      return "unauthorized (check MC_AUTH_TOKEN)";
    case "unreachable":
      return `unreachable (${health.reason})`;
    case "http_error":
      return `http_${health.status}`;
    default:
      return "unknown";
  }
}
