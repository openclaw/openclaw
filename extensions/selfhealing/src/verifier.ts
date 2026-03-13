import { execSync } from "node:child_process";
import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type TrackedProcess = {
  process: string;
  logFile: string | null;
  command: string;
  startedAt: number;
};

export type VerificationResult = {
  passed: boolean;
  reason: string;
};

// Stored reference to the config — set once at plugin registration
let _config: OpenClawConfig | null = null;
let _workspaceDir = "";

type RunEmbeddedFn = (params: Record<string, unknown>) => Promise<unknown>;
let _runner: RunEmbeddedFn | null = null;

async function getRunner(): Promise<RunEmbeddedFn> {
  if (_runner) return _runner;
  for (const p of [
    "../../../src/agents/pi-embedded-runner.js",
    "../../../dist/agents/pi-embedded-runner.js",
  ]) {
    try {
      const mod = await import(p);
      if (typeof mod.runEmbeddedPiAgent === "function") {
        _runner = mod.runEmbeddedPiAgent as RunEmbeddedFn;
        return _runner;
      }
    } catch {
      // try next
    }
  }
  throw new Error("selfhealing: runEmbeddedPiAgent not available");
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  const raw = (payloads ?? [])
    .filter((p) => !p.isError && p.text)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function configure(config: OpenClawConfig, workspaceDir: string): void {
  _config = config;
  _workspaceDir = workspaceDir;
}

// Extract provider/model from the config — same model the agent uses
function resolveModel(): { provider: string; model: string } | null {
  const defaultsModel = _config?.agents?.defaults?.model;
  const primary =
    typeof defaultsModel === "string"
      ? defaultsModel.trim()
      : ((defaultsModel as Record<string, unknown> | undefined)?.primary?.toString().trim() ??
        undefined);
  if (!primary) return null;
  const provider = primary.split("/")[0];
  const model = primary.split("/").slice(1).join("/");
  if (!provider || !model) return null;
  return { provider, model };
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
  };
}

// Detect if the agent's response claims success or completion
// Uses text scanning — fast, zero latency, no inference cost
// The LLM is better used for harder tasks; claim detection is straightforward
export function detectClaim(text: string): boolean {
  if (!text || text.length < 20) return false;
  const lower = text.toLowerCase();
  return /\b(i'?ve (successfully|started|set up|created|deployed|launched)|is now running|monitoring (has |is )?(started|running|active)|the (script|monitor|bot|process) is (running|active|live)|up and running|started monitoring|hello message.*sent|you (should|will) (receive|get|see))\b/.test(
    lower,
  );
}

// Check if a process is still alive
function isProcessAlive(processName: string): boolean {
  try {
    const result = execSync(`ps aux | grep "${processName}" | grep -v grep`, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// Read the tail of a log file
function readLogTail(logFile: string, lines = 10): string | null {
  try {
    if (!fs.existsSync(logFile)) return null;
    const result = execSync(`tail -${lines} "${logFile}"`, {
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
export function verifyAll(tracked: TrackedProcess[]): VerificationResult {
  if (tracked.length === 0) {
    return { passed: true, reason: "no processes to verify" };
  }

  const ordered = [...tracked].reverse();
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
