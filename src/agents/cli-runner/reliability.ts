import path from "node:path";
import type { CliBackendConfig } from "../../config/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runExec } from "../../process/exec.js";
import { escapeRegExp } from "../../utils.js";

const log = createSubsystemLogger("agent/cli-runner/reliability");
const DEFAULT_RESUME_STALE_SECONDS = 120;
const DEFAULT_MIN_TIMEOUT_MS = 1_000;
const DEFAULT_RESUME_WATCHDOG = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 180_000,
};
const DEFAULT_FRESH_WATCHDOG = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 600_000,
};

type PsProcessEntry = {
  pid: number;
  stat: string;
  etimesSec?: number;
  command: string;
};

function parsePsLine(line: string, opts?: { hasElapsed?: boolean }): PsProcessEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (opts?.hasElapsed) {
    const withElapsed = /^(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!withElapsed) {
      return null;
    }
    const pid = Number(withElapsed[1]);
    const etimesSec = Number(withElapsed[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(etimesSec)) {
      return null;
    }
    return {
      pid,
      stat: withElapsed[2] ?? "",
      etimesSec,
      command: withElapsed[4] ?? "",
    };
  }

  const withoutElapsed = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
  if (!withoutElapsed) {
    return null;
  }
  const pid = Number(withoutElapsed[1]);
  if (!Number.isFinite(pid)) {
    return null;
  }
  return {
    pid,
    stat: withoutElapsed[2] ?? "",
    command: withoutElapsed[3] ?? "",
  };
}

function buildResumeMatcher(backend: CliBackendConfig, sessionId: string): RegExp | null {
  const resumeArgs = backend.resumeArgs ?? [];
  if (resumeArgs.length === 0) {
    return null;
  }
  if (!resumeArgs.some((arg) => arg.includes("{sessionId}"))) {
    return null;
  }
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) {
    return null;
  }

  const resumeTokens = resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId));
  const tokens = [commandToken, ...resumeTokens].filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const pattern = tokens
    .map((token, index) => {
      const tokenPattern = escapeRegExp(token);
      return index === 0 ? `(?:^|\\s)${tokenPattern}` : `\\s+${tokenPattern}`;
    })
    .join("");
  return pattern ? new RegExp(pattern) : null;
}

function buildSessionMatchers(backend: CliBackendConfig): RegExp[] {
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) {
    return [];
  }
  const matchers: RegExp[] = [];
  const sessionArg = backend.sessionArg?.trim();
  const sessionArgs = backend.sessionArgs ?? [];
  const resumeArgs = backend.resumeArgs ?? [];

  const addMatcher = (args: string[]) => {
    if (args.length === 0) {
      return;
    }
    const tokens = [commandToken, ...args];
    const pattern = tokens
      .map((token, index) => {
        const tokenPattern = tokenToRegex(token);
        return index === 0 ? `(?:^|\\s)${tokenPattern}` : `\\s+${tokenPattern}`;
      })
      .join("");
    matchers.push(new RegExp(pattern));
  };

  if (sessionArgs.some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(sessionArgs);
  } else if (sessionArg) {
    addMatcher([sessionArg, "{sessionId}"]);
  }

  if (resumeArgs.some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(resumeArgs);
  }

  return matchers;
}

function tokenToRegex(token: string): string {
  if (!token.includes("{sessionId}")) {
    return escapeRegExp(token);
  }
  const parts = token.split("{sessionId}").map((part) => escapeRegExp(part));
  return parts.join("\\S+");
}

function readResumeStaleSeconds(backend: CliBackendConfig) {
  const configured = backend.reliability?.resumeCleanup?.staleSeconds;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_RESUME_STALE_SECONDS;
  }
  return Math.max(1, Math.floor(configured));
}

function pickWatchdogProfile(
  backend: CliBackendConfig,
  useResume: boolean,
): {
  noOutputTimeoutMs?: number;
  noOutputTimeoutRatio: number;
  minMs: number;
  maxMs: number;
} {
  const defaults = useResume ? DEFAULT_RESUME_WATCHDOG : DEFAULT_FRESH_WATCHDOG;
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;

  const ratio = (() => {
    const value = configured?.noOutputTimeoutRatio;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.noOutputTimeoutRatio;
    }
    return Math.max(0.05, Math.min(0.95, value));
  })();
  const minMs = (() => {
    const value = configured?.minMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.minMs;
    }
    return Math.max(DEFAULT_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const maxMs = (() => {
    const value = configured?.maxMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.maxMs;
    }
    return Math.max(DEFAULT_MIN_TIMEOUT_MS, Math.floor(value));
  })();

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === "number" &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(DEFAULT_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  const computed =
    profile.noOutputTimeoutMs ?? Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
  const bounded = Math.min(profile.maxMs, Math.max(profile.minMs, computed));
  // Keep watchdog below global timeout in normal cases.
  const cap = Math.max(DEFAULT_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  return Math.min(bounded, cap);
}

export async function cleanupResumeProcesses(
  backend: CliBackendConfig,
  sessionId: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const matcher = buildResumeMatcher(backend, sessionId);
  if (!matcher) {
    return;
  }

  try {
    const { stdout } = await runExec("ps", ["-ax", "-o", "pid=,stat=,etimes=,command="]);
    const staleSeconds = readResumeStaleSeconds(backend);
    const candidates: number[] = [];
    for (const line of stdout.split("\n")) {
      const entry = parsePsLine(line, { hasElapsed: true });
      if (!entry || entry.pid === process.pid) {
        continue;
      }
      if (!matcher.test(entry.command)) {
        continue;
      }
      const isStopped = entry.stat.includes("T");
      const isStale = (entry.etimesSec ?? 0) >= staleSeconds;
      if (isStopped || isStale) {
        candidates.push(entry.pid);
      }
    }
    if (candidates.length > 0) {
      log.warn(
        `resume cleanup: killing pids=${candidates.join(",")} session=${sessionId} staleSeconds=${staleSeconds} backend=${path.basename(backend.command)}`,
      );
      await runExec("kill", ["-9", ...candidates.map((pid) => String(pid))]);
    }
  } catch {
    // ignore ps/kill errors - best effort cleanup
  }
}

/**
 * Cleanup suspended OpenClaw CLI processes that have accumulated.
 * Only cleans up if there are more than the threshold (default: 10).
 */
export async function cleanupSuspendedCliProcesses(
  backend: CliBackendConfig,
  threshold = 10,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const matchers = buildSessionMatchers(backend);
  if (matchers.length === 0) {
    return;
  }

  try {
    const { stdout } = await runExec("ps", ["-ax", "-o", "pid=,stat=,command="]);
    const suspended: number[] = [];
    for (const line of stdout.split("\n")) {
      const entry = parsePsLine(line);
      if (!entry) {
        continue;
      }
      if (!entry.stat.includes("T")) {
        continue;
      }
      if (!matchers.some((matcher) => matcher.test(entry.command))) {
        continue;
      }
      suspended.push(entry.pid);
    }

    if (suspended.length > threshold) {
      log.warn(
        `suspended cleanup: killing pids=${suspended.join(",")} threshold=${threshold} backend=${path.basename(backend.command)}`,
      );
      // Verified locally: stopped (T) processes ignore SIGTERM, so use SIGKILL.
      await runExec("kill", ["-9", ...suspended.map((pid) => String(pid))]);
    }
  } catch {
    // ignore errors - best effort cleanup
  }
}
