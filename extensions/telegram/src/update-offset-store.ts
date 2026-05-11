import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const STORE_VERSION = 3;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
};

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveTelegramUpdateOffsetPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}

function extractBotIdFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  const [rawBotId] = trimmed.split(":", 1);
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    return null;
  }
  return rawBotId;
}

function fingerprintFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  return fingerprintTelegramBotToken(trimmed);
}

function safeParseState(parsed: unknown): TelegramUpdateOffsetState | null {
  try {
    const state = parsed as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
      tokenFingerprint?: string | null;
    };
    if (state?.version !== STORE_VERSION && state?.version !== 2 && state?.version !== 1) {
      return null;
    }
    if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) {
      return null;
    }
    if (state.version >= 2 && state.botId !== null && typeof state.botId !== "string") {
      return null;
    }
    if (
      state.version === STORE_VERSION &&
      state.tokenFingerprint !== null &&
      typeof state.tokenFingerprint !== "string"
    ) {
      return null;
    }
    return {
      version: state.version,
      lastUpdateId: state.lastUpdateId ?? null,
      botId: state.version >= 2 ? (state.botId ?? null) : null,
      tokenFingerprint: state.version === STORE_VERSION ? (state.tokenFingerprint ?? null) : null,
    };
  } catch {
    return null;
  }
}

export type TelegramUpdateOffsetRotationInfo = {
  /**
   * Why the stored offset was discarded:
   *   - `bot-id-changed`: the configured token points at a different bot.
   *   - `token-rotated`: same bot id, but the token secret changed
   *     (typically BotFather `/revoke`); the stored fingerprint no longer
   *     matches, so the persisted offset cannot be trusted across the
   *     rotation.
   *   - `legacy-state`: the persisted file predates per-token scoping and
   *     has no fingerprint to verify against the current token.
   */
  reason: "bot-id-changed" | "token-rotated" | "legacy-state";
  /** Previous bot id, when known. */
  previousBotId: string | null;
  /** Bot id derived from the provided token. */
  currentBotId: string;
  /** Stale offset value that was discarded. */
  staleLastUpdateId: number;
};

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Invoked when the stored offset is discarded because the bot identity or
   * token changed. Callers can use this to log a warning and clean up the
   * stale state.
   */
  onRotationDetected?: (info: TelegramUpdateOffsetRotationInfo) => void;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const { value } = await readJsonFileWithFallback<unknown>(filePath, null);
  const parsed = safeParseState(value);
  if (!parsed) {
    return null;
  }
  const expectedBotId = extractBotIdFromToken(params.botToken);
  const expectedFingerprint = fingerprintFromToken(params.botToken);

  const reportRotation = (reason: TelegramUpdateOffsetRotationInfo["reason"]) => {
    if (parsed.lastUpdateId !== null && expectedBotId) {
      params.onRotationDetected?.({
        reason,
        previousBotId: parsed.botId,
        currentBotId: expectedBotId,
        staleLastUpdateId: parsed.lastUpdateId,
      });
    }
  };

  // Different bot entirely (different bot id in the token).
  if (expectedBotId && parsed.botId && parsed.botId !== expectedBotId) {
    reportRotation("bot-id-changed");
    return null;
  }

  // Legacy file from before per-bot scoping; cannot verify identity.
  if (expectedBotId && parsed.botId === null) {
    reportRotation("legacy-state");
    return null;
  }

  // Same bot id, but the token itself changed (e.g. BotFather /revoke).
  // Without a fingerprint match we cannot trust the persisted offset, since
  // a rotated token may start a fresh update_id sequence and lower IDs would
  // otherwise be silently skipped by the in-process update tracker.
  if (
    expectedFingerprint &&
    parsed.tokenFingerprint &&
    parsed.tokenFingerprint !== expectedFingerprint
  ) {
    reportRotation("token-rotated");
    return null;
  }

  return parsed.lastUpdateId ?? null;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUpdateId(params.updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
    tokenFingerprint: fingerprintFromToken(params.botToken),
  };
  await writeJsonFileAtomically(filePath, payload);
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}
