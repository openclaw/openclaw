/**
 * Shell tool — sandboxed command execution.
 * Runs commands with timeout, output capture, and policy checks.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

/**
 * Commands that are always blocked.
 */
const BLOCKED_COMMANDS = new Set([
  "rm -rf /",
  "mkfs",
  "dd if=/dev/zero",
  ":(){ :|:& };:",
  "shutdown",
  "reboot",
  "halt",
]);

/**
 * Commands that require approval before running.
 */
const APPROVAL_PATTERNS = [
  /^rm\s+-rf?\s/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdocker\s+rm\b/,
  /\bkill\s+-9\b/,
  /\bsudo\b/,
  /\bnpm\s+publish\b/,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Check if a command requires approval.
 */
export function requiresApproval(command: string): boolean {
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Check if a command is blocked entirely.
 */
export function isBlocked(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const blocked of BLOCKED_COMMANDS) {
    if (trimmed.startsWith(blocked)) return true;
  }
  return false;
}

/**
 * Execute a shell command with sandboxing.
 */
export async function execShell(
  command: string,
  opts?: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  },
): Promise<ShellResult> {
  if (isBlocked(command)) {
    return {
      stdout: "",
      stderr: `Command blocked by policy: ${command}`,
      exitCode: 1,
      timedOut: false,
      durationMs: 0,
    };
  }

  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  // Build a sanitised env — strip secrets from child process environment
  const sanitisedEnv: Record<string, string> = {};
  const SECRET_ENV_PATTERNS = /KEY|SECRET|TOKEN|PASS|PASSWORD|CREDENTIAL/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERNS.test(key)) continue; // Strip secrets from child env
    sanitisedEnv[key] = value;
  }

  const options: ExecFileOptions = {
    cwd: opts?.cwd,
    timeout,
    maxBuffer: MAX_OUTPUT_CHARS * 2,
    env: { ...sanitisedEnv, ...opts?.env },
    shell: true,
  };

  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], options);
    return {
      stdout: truncate(String(stdout), MAX_OUTPUT_CHARS),
      stderr: truncate(String(stderr), MAX_OUTPUT_CHARS),
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const timedOut = err.killed === true || err.code === "ETIMEDOUT";

    return {
      stdout: truncate(err.stdout ?? "", MAX_OUTPUT_CHARS),
      stderr: truncate(err.stderr ?? err.message ?? "", MAX_OUTPUT_CHARS),
      exitCode: err.code ?? 1,
      timedOut,
      durationMs,
    };
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "\n...[truncated]";
}
