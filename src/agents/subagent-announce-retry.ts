/**
 * Subagent announce retry and persistence module.
 *
 * Implements exponential backoff retry for subagent completion announcements
 * and persists failed announcements for recovery.
 *
 * @see https://github.com/openclaw/openclaw/issues/17000
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
import { resolveStateDir } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";

export type FailedAnnouncePayload = {
  sessionId: string;
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  task: string;
  result: string;
  timestamp: number;
  attempts: number;
  lastAttemptAt: number;
  lastError?: string;
  triggerMessage?: string;
  completionMessage?: string;
};

export type AnnounceRetryConfig = {
  /** Base timeout for first attempt (ms). Default: 60000 */
  baseTimeoutMs: number;
  /** Maximum retries before persisting as failed. Default: 3 */
  maxRetries: number;
  /** Backoff multiplier for each retry. Default: 2 */
  backoffMultiplier: number;
};

const DEFAULT_RETRY_CONFIG: AnnounceRetryConfig = {
  baseTimeoutMs: 60_000,
  maxRetries: 3,
  backoffMultiplier: 2,
};

/**
 * Resolves announce timeout from config with fallback to default.
 * Checks per-agent override first, then global defaults.
 */
export function resolveAnnounceTimeoutMs(agentId?: string): number {
  const cfg = loadConfig();

  // Check per-agent override
  if (agentId) {
    const agentConfig = cfg.agents?.list?.[agentId];
    const perAgentTimeout = agentConfig?.subagents?.announceTimeoutMs;
    if (typeof perAgentTimeout === "number" && perAgentTimeout > 0) {
      return perAgentTimeout;
    }
  }

  // Check global defaults
  const globalTimeout = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  if (typeof globalTimeout === "number" && globalTimeout > 0) {
    return globalTimeout;
  }

  // Default: 120000ms (2 minutes)
  return 120_000;
}

/**
 * Resolves the retry configuration.
 */
export function resolveRetryConfig(agentId?: string): AnnounceRetryConfig {
  const baseTimeoutMs = resolveAnnounceTimeoutMs(agentId);
  return {
    ...DEFAULT_RETRY_CONFIG,
    baseTimeoutMs,
  };
}

/**
 * Calculate timeout for a specific retry attempt using exponential backoff.
 * Attempt 1: baseTimeoutMs (60s default)
 * Attempt 2: baseTimeoutMs * 2 (120s)
 * Attempt 3: baseTimeoutMs * 4 (240s)
 */
export function calculateRetryTimeout(
  attempt: number,
  config: AnnounceRetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const multiplier = Math.pow(config.backoffMultiplier, attempt - 1);
  return Math.min(config.baseTimeoutMs * multiplier, 300_000); // Cap at 5 minutes
}

/**
 * Resolve the directory for failed announce persistence.
 */
export function resolveFailedAnnounceDir(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "announce-failed");
}

/**
 * Ensure the failed announce directory exists.
 */
function ensureFailedAnnounceDir(): string {
  const dir = resolveFailedAnnounceDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generate a filename for a failed announce payload.
 */
function failedAnnounceFilename(sessionId: string): string {
  // Sanitize sessionId for filesystem
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe}.json`;
}

/**
 * Persist a failed announcement for later recovery.
 */
export function persistFailedAnnounce(payload: FailedAnnouncePayload): string {
  const dir = ensureFailedAnnounceDir();
  const filename = failedAnnounceFilename(payload.sessionId);
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf-8");

  defaultRuntime.error?.(
    `[announce-persist] Saved failed announcement for session ${payload.sessionId} to ${filepath}`,
  );

  return filepath;
}

/**
 * Load a failed announcement by sessionId.
 */
export function loadFailedAnnounce(sessionId: string): FailedAnnouncePayload | undefined {
  const dir = resolveFailedAnnounceDir();
  const filename = failedAnnounceFilename(sessionId);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(filepath, "utf-8");
    return JSON.parse(content) as FailedAnnouncePayload;
  } catch (err) {
    defaultRuntime.error?.(`[announce-persist] Failed to load ${filepath}: ${String(err)}`);
    return undefined;
  }
}

/**
 * List all failed announcements.
 */
export function listFailedAnnounces(): FailedAnnouncePayload[] {
  const dir = resolveFailedAnnounceDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const payloads: FailedAnnouncePayload[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      payloads.push(JSON.parse(content) as FailedAnnouncePayload);
    } catch {
      // Skip malformed files
    }
  }

  return payloads.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Remove a failed announcement after successful recovery.
 */
export function removeFailedAnnounce(sessionId: string): boolean {
  const dir = resolveFailedAnnounceDir();
  const filename = failedAnnounceFilename(sessionId);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return false;
  }

  try {
    fs.unlinkSync(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the failure notification message for the user.
 */
export function buildAnnounceFailureNotification(sessionId: string): string {
  return `⚠️ Sub-agent completed but delivery failed — use /subagents log ${sessionId} to view results`;
}

/**
 * Log retry attempt.
 */
export function logRetryAttempt(params: {
  sessionId: string;
  attempt: number;
  maxRetries: number;
  timeoutMs: number;
}): void {
  defaultRuntime.warn?.(
    `[announce retry ${params.attempt}/${params.maxRetries}] for subagent ${params.sessionId} (timeout: ${params.timeoutMs}ms)`,
  );
}

/**
 * Log final failure with recovery instructions.
 */
export function logFinalFailure(params: {
  sessionId: string;
  childSessionKey: string;
  attempts: number;
  lastError: string;
}): void {
  defaultRuntime.error?.(
    [
      `[announce FAILED] Subagent completion announcement failed after ${params.attempts} attempts`,
      `  Session ID: ${params.sessionId}`,
      `  Session Key: ${params.childSessionKey}`,
      `  Last Error: ${params.lastError}`,
      `  Recovery: Run "openclaw subagents recover ${params.sessionId}" to retry delivery`,
      `  Or use "/subagents log ${params.sessionId}" to view the results`,
    ].join("\n"),
  );
}

/**
 * Execute a function with retry and exponential backoff.
 */
export async function withAnnounceRetry<T>(
  fn: (attempt: number, timeoutMs: number) => Promise<T>,
  params: {
    sessionId: string;
    agentId?: string;
    onAttempt?: (attempt: number, timeoutMs: number) => void;
    onFailure?: (attempt: number, error: unknown) => void;
  },
): Promise<{ success: true; result: T } | { success: false; attempts: number; lastError: string }> {
  const config = resolveRetryConfig(params.agentId);
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const timeoutMs = calculateRetryTimeout(attempt, config);

    logRetryAttempt({
      sessionId: params.sessionId,
      attempt,
      maxRetries: config.maxRetries,
      timeoutMs,
    });

    params.onAttempt?.(attempt, timeoutMs);

    try {
      const result = await fn(attempt, timeoutMs);
      return { success: true, result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      params.onFailure?.(attempt, err);

      if (attempt < config.maxRetries) {
        // Wait before next retry (small delay to prevent hammering)
        const delayMs = Math.min(1000 * attempt, 5000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return { success: false, attempts: config.maxRetries, lastError };
}
