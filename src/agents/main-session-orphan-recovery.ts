/**
 * Post-restart orphan recovery for main-agent sessions.
 *
 * When the gateway restarts mid tool-use loop, the session transcript
 * ends in persisted tool_result entries with no trailing assistant
 * message. The session-store entry stays `status: "running"`, which
 * makes subsequent user messages see the "currently busy" guard and
 * the session is effectively dead until manually reset.
 *
 * This module scans every main-agent session store at startup, resumes
 * sessions whose transcript tail is a tool_result without a trailing
 * assistant message, and marks stale "running" entries as failed so the
 * busy guard clears.
 *
 * @see https://github.com/openclaw/openclaw/issues/70555
 */

import crypto from "node:crypto";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";

const log = createSubsystemLogger("main-session-orphan-recovery");

/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5_000;

/**
 * Maximum time a session can remain `status: "running"` without
 * `updatedAt` progress before it is considered unrecoverable. Aligned
 * with `2 * SESSION_LOCK_STALE_MS` so orphan recovery and lock cleanup
 * agree on what "too stale to touch" means.
 */
const SESSION_RUNNING_STALE_MS = 60 * 60 * 1000;

const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
const MAX_LAST_HUMAN_MESSAGE_LEN = 2000;
const GATEWAY_RESUME_TIMEOUT_MS = 10_000;

export type MainSessionRecoveryResult = {
  recovered: number;
  failed: number;
  skipped: number;
  expired: number;
};

/**
 * Exclude session keys that already have their own recovery (subagent) or
 * lifecycle ownership (cron, ACP). Also treat any entry with a non-null
 * `subagentRole` or positive `spawnDepth` as out-of-scope, so callers of
 * `acp-spawn` / `subagent-spawn` whose key shape drifts from the canonical
 * `:subagent:` format are still skipped.
 */
function shouldSkipForMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
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

function getMessageRole(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const role = (msg as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isCompactionMarker(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const meta = (msg as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object") {
    return false;
  }
  return (meta as { kind?: unknown }).kind === "compaction";
}

function hasToolResultContent(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_result",
  );
}

function extractMessageText(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (c: unknown) =>
          typeof c === "object" &&
          c !== null &&
          (c as Record<string, unknown>).type === "text" &&
          typeof (c as Record<string, unknown>).text === "string",
      )
      .map((c: unknown) => (c as Record<string, string>).text)
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

/**
 * A session is resumable when the newest meaningful turn is a tool_result
 * (with no trailing assistant message). Walking backwards past compaction
 * markers, the first turn we decide on is either:
 *   - an assistant turn              → tool-use loop already completed
 *   - a tool_result carrier          → orphaned mid-loop, resume it
 *   - a plain user turn              → pending new request, not our bug shape
 */
export function isMainSessionResumable(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (isCompactionMarker(msg)) {
      continue;
    }
    const role = getMessageRole(msg);
    if (role === "assistant") {
      return false;
    }
    if ((role === "user" || role === "tool") && hasToolResultContent(msg)) {
      return true;
    }
    if (role === "user" || role === "tool") {
      return false;
    }
  }
  return false;
}

function findLastHumanMessage(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (isCompactionMarker(msg)) {
      continue;
    }
    if (getMessageRole(msg) !== "user" || hasToolResultContent(msg)) {
      continue;
    }
    const text = extractMessageText(msg);
    if (text) {
      return text.length > MAX_LAST_HUMAN_MESSAGE_LEN
        ? `${text.slice(0, MAX_LAST_HUMAN_MESSAGE_LEN)}...`
        : text;
    }
  }
  return undefined;
}

function buildResumeMessage(lastHumanMessage?: string): string {
  let message =
    `[System] Your previous turn was interrupted by a gateway restart while ` +
    `tool results were being persisted. Continue from where you left off.`;
  if (lastHumanMessage) {
    message += `\n\nThe last message from the user before the interruption was:\n\n${lastHumanMessage}`;
  }
  return message;
}

async function resumeOrphanedMainSession(params: {
  sessionKey: string;
  lastHumanMessage?: string;
}): Promise<boolean> {
  const resumeMessage = buildResumeMessage(params.lastHumanMessage);
  try {
    await callGateway({
      method: "agent",
      params: {
        message: resumeMessage,
        sessionKey: params.sessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: CommandLane.Main,
      },
      timeoutMs: GATEWAY_RESUME_TIMEOUT_MS,
    });
    log.info(`resumed orphaned main session: ${params.sessionKey}`);
    return true;
  } catch (err) {
    log.warn(`failed to resume orphaned main session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

async function markSessionFailed(params: {
  storePath: string;
  sessionKey: string;
  nowMs: number;
}): Promise<void> {
  try {
    await updateSessionStore(params.storePath, (store) => {
      const entry = store[params.sessionKey];
      if (!entry || entry.status !== "running") {
        return;
      }
      entry.status = "failed";
      entry.abortedLastRun = true;
      if (typeof entry.endedAt !== "number") {
        entry.endedAt = params.nowMs;
      }
      entry.updatedAt = params.nowMs;
      store[params.sessionKey] = entry;
    });
  } catch (err) {
    log.warn(`failed to mark stale main session ${params.sessionKey} as failed: ${String(err)}`);
  }
}

async function processAgentSessionStore(params: {
  storePath: string;
  nowMs: number;
  staleMs: number;
  resumedSessionKeys: Set<string>;
  result: MainSessionRecoveryResult;
}): Promise<void> {
  const { storePath, nowMs, staleMs, resumedSessionKeys, result } = params;
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(storePath);
  } catch (err) {
    log.warn(`failed to load main-session store ${storePath}: ${String(err)}`);
    return;
  }

  for (const sessionKey of Object.keys(store).toSorted()) {
    const entry = store[sessionKey];
    if (!entry || entry.status !== "running") {
      continue;
    }
    if (shouldSkipForMainRecovery(entry, sessionKey)) {
      continue;
    }
    if (resumedSessionKeys.has(sessionKey)) {
      result.skipped++;
      continue;
    }

    const ageMs = typeof entry.updatedAt === "number" ? nowMs - entry.updatedAt : Infinity;
    const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const resumable = isMainSessionResumable(messages);

    if (!resumable) {
      if (ageMs > staleMs) {
        await markSessionFailed({ storePath, sessionKey, nowMs });
        result.expired++;
      } else {
        result.skipped++;
      }
      continue;
    }

    if (ageMs > staleMs) {
      // Resumable shape but idle beyond the stale window: treat as
      // unrecoverable so we do not resurrect abandoned sessions.
      await markSessionFailed({ storePath, sessionKey, nowMs });
      result.expired++;
      continue;
    }

    log.info(`found orphaned main session: ${sessionKey}`);
    const resumed = await resumeOrphanedMainSession({
      sessionKey,
      lastHumanMessage: findLastHumanMessage(messages),
    });

    if (resumed) {
      resumedSessionKeys.add(sessionKey);
      result.recovered++;
    } else {
      // Flag stays as status=running so the next restart can retry
      // the resume without touching transcript state.
      result.failed++;
    }
  }
}

export async function recoverOrphanedMainSessions(
  params: {
    stateDir?: string;
    nowMs?: number;
    staleMs?: number;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<MainSessionRecoveryResult> {
  const result: MainSessionRecoveryResult = {
    recovered: 0,
    failed: 0,
    skipped: 0,
    expired: 0,
  };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const nowMs = params.nowMs ?? Date.now();
  const staleMs = params.staleMs ?? SESSION_RUNNING_STALE_MS;

  try {
    const stateDir = params.stateDir ?? resolveStateDir(process.env);
    const cfg = loadConfig();
    const configuredStore = cfg.session?.store;
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    const seenStorePaths = new Set<string>();

    for (const sessionsDir of sessionDirs) {
      const agentId = path.basename(path.dirname(sessionsDir));
      const storePath = resolveStorePath(configuredStore, { agentId });
      if (seenStorePaths.has(storePath)) {
        continue;
      }
      seenStorePaths.add(storePath);
      await processAgentSessionStore({
        storePath,
        nowMs,
        staleMs,
        resumedSessionKeys,
        result,
      });
    }
  } catch (err) {
    log.warn(`main-session orphan recovery scan failed: ${String(err)}`);
    if (result.failed === 0) {
      result.failed = 1;
    }
  }

  if (result.recovered > 0 || result.failed > 0 || result.expired > 0) {
    log.info(
      `main-session orphan recovery complete: recovered=${result.recovered} failed=${result.failed} expired=${result.expired} skipped=${result.skipped}`,
    );
  }
  return result;
}

export function scheduleMainSessionOrphanRecovery(
  params: {
    delayMs?: number;
    maxRetries?: number;
    staleMs?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverOrphanedMainSessions({
        stateDir: params.stateDir,
        staleMs: params.staleMs,
        resumedSessionKeys,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
            log.info(
              `main-session orphan recovery had ${result.failed} failure(s); retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            attemptRecovery(attempt + 1, nextDelay);
          }
        })
        .catch((err) => {
          if (attempt < maxRetries) {
            const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
            log.warn(
              `scheduled main-session orphan recovery failed: ${String(err)}; retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            attemptRecovery(attempt + 1, nextDelay);
          } else {
            log.warn(
              `scheduled main-session orphan recovery failed after ${maxRetries} retries: ${String(err)}`,
            );
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(0, initialDelay);
}
