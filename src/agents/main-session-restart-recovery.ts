/**
 * Post-restart recovery for main sessions marked as interrupted.
 */

import crypto from "node:crypto";
import {
  type SessionEntry,
  getSessionEntry,
  listSessionEntries,
  resolveAgentIdFromSessionKey,
  upsertSessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return true;
  }
  if (entry.subagentRole != null) {
    return true;
  }
  return (
    isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) || isAcpSessionKey(sessionKey)
  );
}

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  if (!role || role === "system") {
    return false;
  }
  return true;
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isApprovalPendingToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return false;
  }
  return (details as { status?: unknown }).status === "approval-pending";
}

function resolveMainSessionResumeBlockReason(messages: unknown[]): string | null {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return "transcript tail is not resumable";
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return "transcript tail is a stale approval-pending tool result";
  }
  return null;
}

function buildResumeMessage(pendingFinalDeliveryText?: string | null): string {
  const base =
    "[System] Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. Continue from the existing " +
    "transcript and finish the interrupted response.";
  if (pendingFinalDeliveryText) {
    return `${base}\n\nNote: The interrupted final reply was captured: "${pendingFinalDeliveryText}"`;
  }
  return base;
}

async function markSessionFailed(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  const entry = getSessionEntry({
    agentId: params.agentId,
    env: params.env,
    sessionKey: params.sessionKey,
  });
  if (!entry || entry.status !== "running") {
    return;
  }
  const now = Date.now();
  upsertSessionEntry({
    agentId: params.agentId,
    env: params.env,
    sessionKey: params.sessionKey,
    entry: {
      ...entry,
      status: "failed",
      abortedLastRun: true,
      endedAt: now,
      updatedAt: now,
      pendingFinalDelivery: undefined,
      pendingFinalDeliveryText: undefined,
      pendingFinalDeliveryCreatedAt: undefined,
      pendingFinalDeliveryLastAttemptAt: undefined,
      pendingFinalDeliveryAttemptCount: undefined,
      pendingFinalDeliveryLastError: undefined,
      pendingFinalDeliveryContext: undefined,
    },
  });
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}

async function resumeMainSession(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
}): Promise<boolean> {
  try {
    await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: buildResumeMessage(params.pendingFinalDeliveryText),
        sessionKey: params.sessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: CommandLane.Main,
      },
      timeoutMs: 10_000,
    });
    const entry = getSessionEntry({
      agentId: params.agentId,
      env: params.env,
      sessionKey: params.sessionKey,
    });
    if (entry) {
      const now = Date.now();
      const next: SessionEntry = {
        ...entry,
        abortedLastRun: false,
        updatedAt: now,
      };
      if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
        next.pendingFinalDeliveryLastAttemptAt = now;
        next.pendingFinalDeliveryAttemptCount = (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
        next.pendingFinalDeliveryLastError = null;
      }
      upsertSessionEntry({
        agentId: params.agentId,
        env: params.env,
        sessionKey: params.sessionKey,
        entry: next,
      });
    }
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        params.pendingFinalDeliveryText ? " (with pending payload)" : ""
      }`,
    );
    return true;
  } catch (err) {
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

async function recoverStore(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  resumedSessionKeys: Set<string>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  let rows: Array<{ sessionKey: string; entry: SessionEntry }>;
  try {
    rows = listSessionEntries({ agentId: params.agentId, env: params.env });
  } catch (err) {
    log.warn(`failed to load session rows for agent ${params.agentId}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry } of rows.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (params.resumedSessionKeys.has(sessionKey)) {
      result.skipped++;
      continue;
    }

    let messages: unknown[];
    try {
      messages = await readSessionMessagesAsync(entry.sessionId, undefined, {
        agentId: resolveAgentIdFromSessionKey(sessionKey),
        mode: "recent",
        maxMessages: 20,
        maxBytes: 256 * 1024,
      });
    } catch (err) {
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      await markSessionFailed({
        agentId: params.agentId,
        env: params.env,
        sessionKey,
        reason: resumeBlockReason,
      });
      result.failed++;
      continue;
    }

    const resumed = await resumeMainSession({
      agentId: params.agentId,
      env: params.env,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
    });
    if (resumed) {
      params.resumedSessionKeys.add(sessionKey);
      result.recovered++;
    } else {
      result.failed++;
    }
  }

  return result;
}

function resolveRecoveryEnv(stateDir?: string): NodeJS.ProcessEnv | undefined {
  return stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : undefined;
}

export async function recoverRestartAbortedMainSessions(
  params: {
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const env = resolveRecoveryEnv(params.stateDir);
  const agentDatabases = listOpenClawRegisteredAgentDatabases({ env });

  for (const agentDatabase of agentDatabases) {
    const storeResult = await recoverStore({
      agentId: agentDatabase.agentId,
      env,
      resumedSessionKeys,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

export function scheduleRestartAbortedMainSessionRecovery(
  params: {
    delayMs?: number;
    maxRetries?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverRestartAbortedMainSessions({
        stateDir: params.stateDir,
        resumedSessionKeys,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
        })
        .catch((err) => {
          if (attempt < maxRetries) {
            log.warn(`main-session restart recovery failed: ${String(err)}`);
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          } else {
            log.warn(`main-session restart recovery gave up: ${String(err)}`);
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(1, initialDelay);
}
