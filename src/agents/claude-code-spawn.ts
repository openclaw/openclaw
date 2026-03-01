import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

const HAIKU_MODEL = "claude-3-5-haiku-latest";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/** Check interval for stuck detection (10 minutes). */
const STUCK_CHECK_INTERVAL_MS = 10 * 60_000;
const HAIKU_TIMEOUT_MS = 15_000;

const STUCK_CLASSIFICATION_SYSTEM_PROMPT =
  "You are a process monitor. Given the last few lines of a Claude Code JSONL session log, determine if the process is still making progress or is stuck. Reply with exactly one word: alive (making progress, recent tool calls or output) or stuck (no meaningful progress, repeated errors, or idle). Nothing else.";

export type SpawnClaudeCodeResult = {
  status: "accepted" | "error";
  childSessionKey?: string;
  runId?: string;
  note?: string;
  error?: string;
};

export type SpawnClaudeCodeParams = {
  task: string;
  label?: string;
  cwd?: string;
};

export type SpawnClaudeCodeContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
};

function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
}

/**
 * Resolve the Claude Code JSONL session directory for a given working directory.
 * Path: ~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/
 */
function resolveClaudeCodeSessionDir(cwd: string): string {
  const slug = cwd.replace(/^\//, "").replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

/**
 * Find the most recently modified .jsonl file in a directory.
 */
function findLatestJsonlFile(dir: string): string | undefined {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) {
      return undefined;
    }
    let latest: { name: string; mtimeMs: number } | undefined;
    for (const file of files) {
      const stat = fs.statSync(path.join(dir, file));
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { name: file, mtimeMs: stat.mtimeMs };
      }
    }
    return latest ? path.join(dir, latest.name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the last N bytes of a file for stuck classification.
 */
function readTail(filePath: string, bytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Call Haiku to classify whether a Claude Code process is alive or stuck.
 */
async function classifyStuck(sessionLogTail: string): Promise<"alive" | "stuck"> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    // Can't classify without API key; assume alive to avoid false kills.
    return "alive";
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 10,
        system: STUCK_CLASSIFICATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here are the last lines of the session log:\n\n${sessionLogTail}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!response.ok) {
      return "alive";
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data?.content?.[0]?.text?.trim().toLowerCase();
    if (text === "stuck") {
      return "stuck";
    }
    return "alive";
  } catch {
    return "alive";
  }
}

/**
 * Monitor a Claude Code child process for stuck detection.
 * Checks the JSONL session file every 10 minutes.
 * If file size is unchanged between checks, calls Haiku to classify.
 * If stuck, kills the process.
 */
function monitorClaudeCodeProcess(params: {
  childProcess: ReturnType<typeof spawn>;
  cwd: string;
  runId: string;
  onStuck: () => void;
}): NodeJS.Timeout {
  const sessionDir = resolveClaudeCodeSessionDir(params.cwd);
  let lastFileSize: number | undefined;
  let lastFilePath: string | undefined;

  const timer = setInterval(() => {
    // Check if process is still running.
    if (params.childProcess.exitCode !== null) {
      clearInterval(timer);
      return;
    }

    const jsonlFile = findLatestJsonlFile(sessionDir);
    if (!jsonlFile) {
      // No session file yet; skip this check.
      return;
    }

    try {
      const stat = fs.statSync(jsonlFile);
      const currentSize = stat.size;

      // If file changed or this is the first check, record and move on.
      if (
        lastFilePath !== jsonlFile ||
        lastFileSize === undefined ||
        currentSize !== lastFileSize
      ) {
        lastFilePath = jsonlFile;
        lastFileSize = currentSize;
        return;
      }

      // File size unchanged — classify with Haiku.
      const tail = readTail(jsonlFile, 8_000);
      if (!tail) {
        return;
      }

      void classifyStuck(tail).then((classification) => {
        if (classification === "stuck" && params.childProcess.exitCode === null) {
          defaultRuntime.log(`[warn] Claude Code process stuck, killing run=${params.runId}`);
          params.childProcess.kill("SIGTERM");
          // Give it a moment, then force kill.
          setTimeout(() => {
            if (params.childProcess.exitCode === null) {
              params.childProcess.kill("SIGKILL");
            }
          }, 5_000).unref?.();
          params.onStuck();
          clearInterval(timer);
        }
      });
    } catch {
      // Ignore stat errors.
    }
  }, STUCK_CHECK_INTERVAL_MS);

  timer.unref?.();
  return timer;
}

export async function spawnClaudeCodeDirect(
  params: SpawnClaudeCodeParams,
  ctx: SpawnClaudeCodeContext,
): Promise<SpawnClaudeCodeResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const cwd = params.cwd || process.cwd();
  const cfg = loadConfig();
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });

  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({ key: requesterSessionKey, alias, mainKey })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const runId = crypto.randomUUID();
  const childSessionKey = `claude-code:${runId}`;

  // Spawn claude CLI in the background.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("claude", ["-p", "--dangerously-skip-permissions", task], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    });
    // Unref so the parent process can exit independently.
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error: `Failed to spawn claude CLI: ${message}`,
    };
  }

  // Register in the subagent registry so announce flow works.
  registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    requesterDisplayKey,
    task,
    cleanup: "keep",
    label: label || undefined,
    model: "claude-code",
    expectsCompletionMessage: true,
    spawnMode: "run",
  });

  // Collect stdout/stderr for the announce outcome.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let wasStuck = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // Start stuck detection monitor.
  const monitorTimer = monitorClaudeCodeProcess({
    childProcess: child,
    cwd,
    runId,
    onStuck: () => {
      wasStuck = true;
    },
  });

  // Handle process exit — trigger announce flow via the registry.
  child.on("close", (code) => {
    clearInterval(monitorTimer);

    const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
    const isSuccess = code === 0 && !wasStuck;

    const summary = wasStuck
      ? "Claude Code process was detected as stuck and killed."
      : isSuccess
        ? stdout.slice(-4_000) || "(completed with no output)"
        : `Exit code ${code ?? "unknown"}${stderr ? `: ${stderr.slice(-2_000)}` : ""}`;

    defaultRuntime.log(
      `[info] Claude Code process exited code=${code} stuck=${wasStuck} run=${runId}`,
    );

    // Announce completion via the gateway so the requester gets notified.
    // We use callGateway agent method to send the result back.
    void announceClaudeCodeCompletion({
      childSessionKey,
      requesterSessionKey: requesterInternalKey,
      requesterDisplayKey,
      requesterOrigin,
      runId,
      task,
      label: label || undefined,
      summary,
      isSuccess,
    });
  });

  child.on("error", (err) => {
    clearInterval(monitorTimer);
    defaultRuntime.log(`[error] Claude Code process error run=${runId}: ${err.message}`);
  });

  return {
    status: "accepted",
    childSessionKey,
    runId,
    note: "Claude Code CLI spawned; auto-announces on completion, do not poll/sleep.",
  };
}

async function announceClaudeCodeCompletion(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterDisplayKey: string;
  requesterOrigin?: ReturnType<typeof normalizeDeliveryContext>;
  runId: string;
  task: string;
  label?: string;
  summary: string;
  isSuccess: boolean;
}): Promise<void> {
  // Import lazily to avoid circular dependency at module load.
  const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

  try {
    await runSubagentAnnounceFlow({
      childSessionKey: params.childSessionKey,
      childRunId: params.runId,
      requesterSessionKey: params.requesterSessionKey,
      requesterOrigin: params.requesterOrigin,
      requesterDisplayKey: params.requesterDisplayKey,
      task: params.task,
      timeoutMs: 120_000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: undefined,
      endedAt: Date.now(),
      label: params.label,
      outcome: params.isSuccess ? { status: "ok" } : { status: "error", error: params.summary },
      spawnMode: "run",
      expectsCompletionMessage: true,
    });
  } catch (err) {
    defaultRuntime.log(
      `[warn] Claude Code announce failed run=${params.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
