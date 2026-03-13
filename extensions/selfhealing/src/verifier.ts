import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type TrackedProcess = {
  process: string;
  logFile: string | null;
  command: string;
  startedAt: number;
  kind: "exec" | "subagent";
};

export type VerificationResult = {
  passed: boolean;
  reason: string;
};

// Sanitize a string for safe use in shell arguments — strip anything dangerous
function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9._\-\/]/g, "");
}

// Extract process name from a command string
function extractProcessName(command: string): string | null {
  const match = command.match(/(?:nohup\s+)?(?:\.\/|python3?\s+|node\s+|bash\s+|sh\s+)([^\s>|&]+)/);
  return match?.[1] ?? null;
}

// Extract log file path from a command string
function extractLogFile(command: string): string | null {
  const match = command.match(/>>?\s*(\/[^\s]+\.log)/);
  return match?.[1] ?? null;
}

// Parse an exec event's command to extract process + log info
export function parseExecCommand(params: Record<string, unknown>): TrackedProcess | null {
  const command = typeof params.command === "string" ? params.command : null;
  if (!command) return null;

  const isBackground = params.background === true || /nohup|&\s*$/.test(command);
  if (!isBackground) return null;

  const processName = extractProcessName(command);
  if (!processName) return null;

  return {
    process: processName,
    logFile: extractLogFile(command),
    command,
    startedAt: Date.now(),
    kind: "exec",
  };
}

// Create a tracked entry for a subagent spawn
export function createSubagentEntry(label: string): TrackedProcess {
  return {
    process: label,
    logFile: null,
    command: `sessions_spawn: ${label}`,
    startedAt: Date.now(),
    kind: "subagent",
  };
}

// Detect if the agent's response claims success or completion
export function detectClaim(text: string): boolean {
  if (!text || text.length < 20) return false;
  const lower = text.toLowerCase();
  return /\b(i'?ve (successfully|started|set up|created|deployed|launched)|is now running|monitoring (has |is )?(started|running|active)|the (script|monitor|bot|process) is (running|active|live)|up and running|started monitoring|hello message.*sent|you (should|will) (receive|get|see))\b/.test(
    lower,
  );
}

// Check if a process is still alive — uses execFileSync to avoid shell injection
function isProcessAlive(processName: string): boolean {
  try {
    const safe = sanitize(processName);
    if (!safe) return false;
    const result = execFileSync("pgrep", ["-f", safe], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// Read the tail of a log file — uses execFileSync to avoid shell injection
function readLogTail(logFile: string, lines = 10): string | null {
  try {
    if (!fs.existsSync(logFile)) return null;
    const result = execFileSync("tail", [`-${lines}`, logFile], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

// Verify all tracked processes for a session
// Only verifies exec processes — subagent entries are skipped since they
// are not OS processes and would always fail ps checks
export function verifyAll(tracked: TrackedProcess[]): VerificationResult {
  const execProcesses = tracked.filter((t) => t.kind === "exec");

  if (execProcesses.length === 0) {
    return { passed: true, reason: "no exec processes to verify" };
  }

  const ordered = [...execProcesses].reverse();
  const failures: string[] = [];
  let anyAlive = false;

  for (const entry of ordered) {
    const alive = isProcessAlive(entry.process);

    if (alive) {
      anyAlive = true;
      if (entry.logFile) {
        const log = readLogTail(entry.logFile);
        if (!log || log.length === 0) {
          failures.push(`${entry.process} is running but log is empty`);
        }
      }
    } else {
      if (entry.logFile) {
        const log = readLogTail(entry.logFile);
        failures.push(
          `${entry.process} is not running. Log: ${log?.slice(0, 100) ?? "no log file"}`,
        );
      } else {
        failures.push(`${entry.process} is not running`);
      }
    }
  }

  if (!anyAlive) {
    return {
      passed: false,
      reason: `No tracked processes are running. ${failures.slice(0, 3).join(" | ")}`,
    };
  }

  if (failures.length > 0) {
    return {
      passed: false,
      reason: failures.slice(0, 3).join(" | "),
    };
  }

  return { passed: true, reason: "all tracked processes running and healthy" };
}
