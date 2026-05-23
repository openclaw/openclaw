import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_FRESHNESS_MS = 30_000;

export type SubagentActivityMonitorDeps = {
  readDir: (dir: string) => Promise<string[]>;
  statFile: (file: string) => Promise<{ mtimeMs: number } | null>;
  emit: (event: { sessionId?: string; sessionKey?: string; runId?: string }) => void;
  now: () => number;
};

const defaultDeps: SubagentActivityMonitorDeps = {
  readDir: async (dir) => {
    try {
      return await fsPromises.readdir(dir);
    } catch {
      return [];
    }
  },
  statFile: async (file) => {
    try {
      const stat = await fsPromises.stat(file);
      return { mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  },
  emit: (event) =>
    emitTrustedDiagnosticEvent({
      type: "run.progress",
      reason: "cli:live:subagent",
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
      runId: event.runId,
    }),
  now: () => Date.now(),
};

/**
 * Encode an absolute filesystem path the same way the Claude CLI does when it
 * computes the per-workspace directory under `~/.claude/projects/<encoded>/`:
 * every `/` and every `.` becomes `-`.
 */
export function encodeClaudeProjectDir(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, "-");
}

export function resolveClaudeSubagentsDir(params: {
  workspaceDir: string;
  cliSessionId: string;
  homeDir?: string;
}): string {
  const home = params.homeDir ?? os.homedir();
  return path.join(
    home,
    ".claude",
    "projects",
    encodeClaudeProjectDir(params.workspaceDir),
    params.cliSessionId,
    "subagents",
  );
}

/**
 * Watch the Claude CLI sub-agent transcript directory for the parent's
 * CLI session and emit a `run.progress` event (reason `cli:live:subagent`)
 * whenever a sub-agent JSONL file is being actively written. This keeps the
 * diagnostic stuck-session watchdog from aborting a parent that is silent
 * only because it is legitimately waiting on a background `Agent` task.
 *
 * The monitor stops on its own if the sub-agent stops touching the file —
 * a genuinely hung sub-agent still gets aborted, because the parent's
 * lastProgressAgeMs grows as expected once the file stops moving.
 */
export function startClaudeSubagentActivityMonitor(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  workspaceDir: string;
  cliSessionId: string;
  intervalMs?: number;
  freshnessMs?: number;
  deps?: Partial<SubagentActivityMonitorDeps>;
}): { stop: () => void } {
  const deps: SubagentActivityMonitorDeps = { ...defaultDeps, ...params.deps };
  const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
  const freshnessMs = params.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const subagentsDir = resolveClaudeSubagentsDir({
    workspaceDir: params.workspaceDir,
    cliSessionId: params.cliSessionId,
  });
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const entries = await deps.readDir(subagentsDir);
      const candidates = entries.filter(
        (name) => name.startsWith("agent-") && name.endsWith(".jsonl"),
      );
      if (candidates.length === 0) {
        return;
      }
      let latestMtimeMs = 0;
      for (const name of candidates) {
        const stat = await deps.statFile(path.join(subagentsDir, name));
        if (stat && stat.mtimeMs > latestMtimeMs) {
          latestMtimeMs = stat.mtimeMs;
        }
      }
      if (latestMtimeMs === 0) {
        return;
      }
      if (deps.now() - latestMtimeMs <= freshnessMs) {
        deps.emit({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: params.runId,
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    },
  };
}
