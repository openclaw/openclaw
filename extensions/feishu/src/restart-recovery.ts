import os from "node:os";
import path from "node:path";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
  type ClawdbotConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";

const RECOVERY_STORE_VERSION = 1;
const PENDING_FINAL_TTL_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_NOTICE_TIMEOUT_MS = 2_000;
const SHUTDOWN_NOTICE_TEXT =
  "System is restarting, so this run was interrupted. If a final result was already generated, it will be resent after restart.";

type FeishuActiveRun = {
  accountId: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  startedAtMs: number;
};

type FeishuPendingFinalReply = {
  pendingId: string;
  accountId: string;
  runMessageId: string;
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  text?: string;
  mediaUrls?: string[];
  createdAtMs: number;
  attempts: number;
  lastAttemptAtMs?: number;
  lastError?: string;
};

type FeishuRecoveryStore = {
  version: 1;
  pendingFinalReplies: Record<string, FeishuPendingFinalReply>;
};

export type BeginFeishuActiveRunParams = {
  accountId: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
};

export type EndFeishuActiveRunParams = {
  accountId: string;
  messageId: string;
};

export type EnqueuePendingFeishuFinalReplyParams = {
  accountId: string;
  runMessageId: string;
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  text?: string;
  mediaUrls?: string[];
  runtime?: RuntimeEnv;
};

export type AckPendingFeishuFinalReplyParams = {
  accountId: string;
  runMessageId: string;
  pendingId?: string;
  runtime?: RuntimeEnv;
};

export type ReplayPendingFeishuFinalRepliesParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
};

export type SendFeishuShutdownInterruptionNoticesParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  timeoutMs?: number;
};

const activeRuns = new Map<string, FeishuActiveRun>();
let storeMutationQueue: Promise<void> = Promise.resolve();

function withStoreMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = storeMutationQueue.then(task, task);
  storeMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveRecoveryStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDirFromEnv(env), "feishu", "restart-recovery.json");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() ? value : undefined;
}

function normalizeMediaUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped.length > 0 ? deduped : undefined;
}

function normalizePendingEntry(value: unknown): FeishuPendingFinalReply | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const pendingId = typeof value.pendingId === "string" ? value.pendingId.trim() : "";
  const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
  const runMessageId = typeof value.runMessageId === "string" ? value.runMessageId.trim() : "";
  const chatId = typeof value.chatId === "string" ? value.chatId.trim() : "";
  if (!pendingId || !accountId || !runMessageId || !chatId) {
    return null;
  }
  const text = normalizeText(value.text);
  const mediaUrls = normalizeMediaUrls(value.mediaUrls);
  if (!text && !mediaUrls) {
    return null;
  }
  const createdAtMs =
    typeof value.createdAtMs === "number" && Number.isFinite(value.createdAtMs)
      ? value.createdAtMs
      : Date.now();
  const attempts =
    typeof value.attempts === "number" && Number.isFinite(value.attempts)
      ? Math.max(0, Math.floor(value.attempts))
      : 0;
  const lastAttemptAtMs =
    typeof value.lastAttemptAtMs === "number" && Number.isFinite(value.lastAttemptAtMs)
      ? value.lastAttemptAtMs
      : undefined;
  const replyToMessageId =
    typeof value.replyToMessageId === "string" && value.replyToMessageId.trim()
      ? value.replyToMessageId.trim()
      : undefined;
  const lastError = typeof value.lastError === "string" ? value.lastError : undefined;

  return {
    pendingId,
    accountId,
    runMessageId,
    chatId,
    replyToMessageId,
    replyInThread: value.replyInThread === true,
    text,
    mediaUrls,
    createdAtMs,
    attempts,
    lastAttemptAtMs,
    lastError,
  };
}

function normalizeRecoveryStore(raw: unknown): FeishuRecoveryStore {
  const normalized: FeishuRecoveryStore = {
    version: RECOVERY_STORE_VERSION,
    pendingFinalReplies: {},
  };
  if (!isObjectRecord(raw)) {
    return normalized;
  }
  const pendingRaw = raw.pendingFinalReplies;
  if (!isObjectRecord(pendingRaw)) {
    return normalized;
  }
  for (const [key, value] of Object.entries(pendingRaw)) {
    const entry = normalizePendingEntry(value);
    if (!entry) {
      continue;
    }
    normalized.pendingFinalReplies[key] = entry;
  }
  return normalized;
}

function buildRunKey(accountId: string, messageId: string): string {
  return `${accountId}:${messageId}`;
}

async function readRecoveryStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeishuRecoveryStore> {
  const { value } = await readJsonFileWithFallback<FeishuRecoveryStore>(
    resolveRecoveryStorePath(env),
    {
      version: RECOVERY_STORE_VERSION,
      pendingFinalReplies: {},
    },
  );
  return normalizeRecoveryStore(value);
}

async function writeRecoveryStore(store: FeishuRecoveryStore): Promise<void> {
  await writeJsonFileAtomically(resolveRecoveryStorePath(), store);
}

function normalizeRequired(value: string | undefined): string {
  return value?.trim() ?? "";
}

function clearActiveRunsForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const runKey of activeRuns.keys()) {
    if (runKey.startsWith(prefix)) {
      activeRuns.delete(runKey);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function deliverPendingFinalReply(params: {
  cfg: ClawdbotConfig;
  entry: FeishuPendingFinalReply;
}): Promise<void> {
  const { cfg, entry } = params;
  if (entry.text) {
    await sendMessageFeishu({
      cfg,
      to: entry.chatId,
      text: entry.text,
      replyToMessageId: entry.replyToMessageId,
      replyInThread: entry.replyInThread,
      accountId: entry.accountId,
    });
  }
  for (const mediaUrl of entry.mediaUrls ?? []) {
    await sendMediaFeishu({
      cfg,
      to: entry.chatId,
      mediaUrl,
      replyToMessageId: entry.replyToMessageId,
      replyInThread: entry.replyInThread,
      accountId: entry.accountId,
    });
  }
}

export function beginFeishuActiveRun(params: BeginFeishuActiveRunParams): void {
  const accountId = normalizeRequired(params.accountId);
  const chatId = normalizeRequired(params.chatId);
  const messageId = normalizeRequired(params.messageId);
  if (!accountId || !chatId || !messageId) {
    return;
  }
  activeRuns.set(buildRunKey(accountId, messageId), {
    accountId,
    chatId,
    messageId,
    replyToMessageId: params.replyToMessageId?.trim() || undefined,
    replyInThread: params.replyInThread === true,
    startedAtMs: Date.now(),
  });
}

export function endFeishuActiveRun(params: EndFeishuActiveRunParams): void {
  const accountId = normalizeRequired(params.accountId);
  const messageId = normalizeRequired(params.messageId);
  if (!accountId || !messageId) {
    return;
  }
  activeRuns.delete(buildRunKey(accountId, messageId));
}

export async function enqueuePendingFeishuFinalReply(
  params: EnqueuePendingFeishuFinalReplyParams,
): Promise<string | undefined> {
  const accountId = normalizeRequired(params.accountId);
  const runMessageId = normalizeRequired(params.runMessageId);
  const chatId = normalizeRequired(params.chatId);
  const text = normalizeText(params.text);
  const mediaUrls = normalizeMediaUrls(params.mediaUrls);

  if (!accountId || !runMessageId || !chatId || (!text && !mediaUrls)) {
    return undefined;
  }

  const pendingId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const pendingKey = buildRunKey(accountId, runMessageId);
  const entry: FeishuPendingFinalReply = {
    pendingId,
    accountId,
    runMessageId,
    chatId,
    replyToMessageId: params.replyToMessageId?.trim() || undefined,
    replyInThread: params.replyInThread === true,
    text,
    mediaUrls,
    createdAtMs: Date.now(),
    attempts: 0,
  };

  try {
    await withStoreMutation(async () => {
      const store = await readRecoveryStore();
      store.pendingFinalReplies[pendingKey] = entry;
      await writeRecoveryStore(store);
    });
    return pendingId;
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${accountId}]: failed to persist pending final reply: ${String(error)}`,
    );
    return undefined;
  }
}

export async function ackPendingFeishuFinalReply(
  params: AckPendingFeishuFinalReplyParams,
): Promise<void> {
  const accountId = normalizeRequired(params.accountId);
  const runMessageId = normalizeRequired(params.runMessageId);
  if (!accountId || !runMessageId) {
    return;
  }
  const pendingKey = buildRunKey(accountId, runMessageId);
  try {
    await withStoreMutation(async () => {
      const store = await readRecoveryStore();
      const current = store.pendingFinalReplies[pendingKey];
      if (!current) {
        return;
      }
      if (params.pendingId && current.pendingId !== params.pendingId) {
        return;
      }
      delete store.pendingFinalReplies[pendingKey];
      await writeRecoveryStore(store);
    });
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${accountId}]: failed to acknowledge pending final reply: ${String(error)}`,
    );
  }
}

export async function replayPendingFeishuFinalReplies(
  params: ReplayPendingFeishuFinalRepliesParams,
): Promise<void> {
  const accountId = normalizeRequired(params.accountId);
  if (!accountId) {
    return;
  }

  const now = Date.now();
  const pending: Array<{ key: string; entry: FeishuPendingFinalReply }> = [];
  let dropped = 0;

  try {
    await withStoreMutation(async () => {
      const store = await readRecoveryStore();
      let mutated = false;
      for (const [key, entry] of Object.entries(store.pendingFinalReplies)) {
        if (entry.accountId !== accountId) {
          continue;
        }
        if (now - entry.createdAtMs > PENDING_FINAL_TTL_MS) {
          delete store.pendingFinalReplies[key];
          dropped += 1;
          mutated = true;
          continue;
        }
        pending.push({ key, entry });
      }
      if (mutated) {
        await writeRecoveryStore(store);
      }
    });
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${accountId}]: failed to load pending final replies: ${String(error)}`,
    );
    return;
  }

  if (pending.length === 0) {
    if (dropped > 0) {
      params.runtime?.log?.(
        `feishu[${accountId}]: dropped ${dropped} stale pending final repl(ies)`,
      );
    }
    return;
  }

  const delivered: Array<{ key: string; pendingId: string }> = [];
  const failed: Array<{ key: string; pendingId: string; error: string }> = [];

  for (const item of pending) {
    try {
      await deliverPendingFinalReply({
        cfg: params.cfg,
        entry: item.entry,
      });
      delivered.push({ key: item.key, pendingId: item.entry.pendingId });
    } catch (error) {
      failed.push({
        key: item.key,
        pendingId: item.entry.pendingId,
        error: String(error),
      });
    }
  }

  try {
    await withStoreMutation(async () => {
      const store = await readRecoveryStore();
      let mutated = false;

      for (const success of delivered) {
        const current = store.pendingFinalReplies[success.key];
        if (!current || current.pendingId !== success.pendingId) {
          continue;
        }
        delete store.pendingFinalReplies[success.key];
        mutated = true;
      }

      for (const failure of failed) {
        const current = store.pendingFinalReplies[failure.key];
        if (!current || current.pendingId !== failure.pendingId) {
          continue;
        }
        current.attempts += 1;
        current.lastAttemptAtMs = Date.now();
        current.lastError = failure.error;
        mutated = true;
      }

      if (mutated) {
        await writeRecoveryStore(store);
      }
    });
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${accountId}]: failed to finalize pending final replay state: ${String(error)}`,
    );
  }

  if (delivered.length > 0 || failed.length > 0 || dropped > 0) {
    params.runtime?.log?.(
      `feishu[${accountId}]: pending final replay summary delivered=${delivered.length} failed=${failed.length} dropped=${dropped}`,
    );
  }
}

export async function sendFeishuShutdownInterruptionNotices(
  params: SendFeishuShutdownInterruptionNoticesParams,
): Promise<number> {
  const accountId = normalizeRequired(params.accountId);
  if (!accountId) {
    return 0;
  }

  const runs = Array.from(activeRuns.values()).filter((run) => run.accountId === accountId);
  if (runs.length === 0) {
    return 0;
  }

  const timeoutMs = Math.max(500, params.timeoutMs ?? SHUTDOWN_NOTICE_TIMEOUT_MS);
  let sent = 0;

  for (const run of runs) {
    try {
      await withTimeout(
        sendMessageFeishu({
          cfg: params.cfg,
          to: run.chatId,
          text: SHUTDOWN_NOTICE_TEXT,
          replyToMessageId: run.replyToMessageId,
          replyInThread: run.replyInThread,
          accountId,
        }),
        timeoutMs,
      );
      sent += 1;
    } catch (error) {
      params.runtime?.error?.(
        `feishu[${accountId}]: failed to send shutdown interruption notice (${run.messageId}): ${String(error)}`,
      );
    }
  }

  clearActiveRunsForAccount(accountId);
  return sent;
}
