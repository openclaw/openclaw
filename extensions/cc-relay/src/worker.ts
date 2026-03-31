import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CcRelayConfig } from "./config.js";
import { extractFinalResult, findLatestSession } from "./session-parser.js";
import type { CcRelayJob } from "./types.js";

/**
 * Execute a Claude Code CLI task in the background.
 *
 * This is the TypeScript equivalent of T800's `worker.sh`:
 * - Builds the Claude CLI command with proper flags
 * - Optionally runs as a different OS user via `runuser`
 * - Captures workspace snapshots before/after for file-change detection
 * - Extracts the final result from the JSONL session (not raw terminal output)
 * - Returns structured results for the caller to relay back to the channel
 */
export interface WorkerResult {
  exitCode: number;
  /** Clean final text extracted from the Claude session JSONL. */
  resultText: string;
  /** Paths of files created or modified during execution. */
  newFiles: string[];
  /** Duration in milliseconds. */
  durationMs: number;
}

export async function runCcWorker(job: CcRelayJob, cfg: CcRelayConfig): Promise<WorkerResult> {
  const workdir = job.workdir || cfg.workdir;
  const startTime = Date.now();

  // Take a "before" snapshot of the workspace
  const snapshotBefore = snapshotWorkspace(workdir);

  // Build the Claude CLI command
  const claudeArgs = buildClaudeArgs(job, cfg);

  let exitCode: number;
  try {
    exitCode = await executeClaudeCli(cfg.claudeBin, claudeArgs, workdir, cfg);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Timeout or other fatal error
    if (message.includes("TIMEOUT")) {
      return {
        exitCode: 124,
        resultText: `Task timed out after ${cfg.timeoutSeconds} seconds.`,
        newFiles: [],
        durationMs: Date.now() - startTime,
      };
    }
    return {
      exitCode: 1,
      resultText: `Execution error: ${message}`,
      newFiles: [],
      durationMs: Date.now() - startTime,
    };
  }

  // Take an "after" snapshot and detect changed files
  const snapshotAfter = snapshotWorkspace(workdir);
  const newFiles = detectNewFiles(snapshotBefore, snapshotAfter, cfg);

  // Extract the final result from the JSONL session file
  const homeDir = cfg.runAsUser ? `/home/${cfg.runAsUser}` : (process.env.HOME ?? "~");
  const sessionFile = findLatestSession(homeDir);
  const resultText = sessionFile ? extractFinalResult(sessionFile) : readFallbackOutput(workdir);

  return {
    exitCode,
    resultText,
    newFiles,
    durationMs: Date.now() - startTime,
  };
}

function buildClaudeArgs(job: CcRelayJob, cfg: CcRelayConfig): string[] {
  const args: string[] = [];

  if (job.permissionMode || cfg.permissionMode) {
    args.push("--permission-mode", job.permissionMode || cfg.permissionMode);
  }

  args.push("-p", job.prompt);

  if (!job.fresh) {
    args.push("--continue");
  }

  return args;
}

async function executeClaudeCli(
  claudeBin: string,
  args: string[],
  workdir: string,
  cfg: CcRelayConfig,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (cfg.model) {
      env.ANTHROPIC_MODEL = cfg.model;
    }

    let cmd: string;
    let spawnArgs: string[];

    if (cfg.runAsUser) {
      // Run as a different user via runuser (Linux)
      const claudeCmd = [claudeBin, ...args].map(shellQuote).join(" ");
      cmd = "runuser";
      spawnArgs = [
        "-u",
        cfg.runAsUser,
        "--",
        "env",
        ...(cfg.model ? [`ANTHROPIC_MODEL=${cfg.model}`] : []),
        `HOME=/home/${cfg.runAsUser}`,
        "bash",
        "-c",
        claudeCmd,
      ];
    } else {
      cmd = claudeBin;
      spawnArgs = args;
    }

    const child = spawn(cmd, spawnArgs, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
      reject(new Error("TIMEOUT"));
    }, cfg.timeoutSeconds * 1000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Take a snapshot of file paths and their modification times in the workspace.
 */
function snapshotWorkspace(workdir: string): Map<string, number> {
  const snap = new Map<string, number>();
  if (!fs.existsSync(workdir)) return snap;

  walkDir(workdir, 4, (filePath) => {
    // Skip noise directories
    if (
      filePath.includes("/cc-relay/results/") ||
      filePath.includes("/.claude/") ||
      filePath.includes("/node_modules/")
    ) {
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      snap.set(filePath, stat.mtimeMs);
    } catch {
      /* skip inaccessible files */
    }
  });
  return snap;
}

function detectNewFiles(
  before: Map<string, number>,
  after: Map<string, number>,
  cfg: CcRelayConfig,
): string[] {
  const newFiles: string[] = [];
  for (const [filePath, mtime] of after) {
    const prevMtime = before.get(filePath);
    if (prevMtime === undefined || prevMtime !== mtime) {
      try {
        const size = fs.statSync(filePath).size;
        if (size <= cfg.maxAttachmentBytes) {
          newFiles.push(filePath);
        }
      } catch {
        /* skip */
      }
    }
    if (newFiles.length >= cfg.maxAttachments) break;
  }
  return newFiles;
}

function walkDir(dir: string, maxDepth: number, cb: (path: string) => void, depth = 0): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, maxDepth, cb, depth + 1);
    } else if (entry.isFile()) {
      cb(full);
    }
  }
}

function readFallbackOutput(workdir: string): string {
  // Fallback: try to read a task-output.txt if JSONL extraction fails
  const outputPath = path.join(workdir, "cc-relay", "results", "task-output.txt");
  try {
    if (fs.existsSync(outputPath)) {
      return stripAnsi(fs.readFileSync(outputPath, "utf-8").trim());
    }
  } catch {
    /* ignore */
  }
  return "(No output captured)";
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07?/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/=:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
