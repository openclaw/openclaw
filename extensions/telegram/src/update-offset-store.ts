import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { getTelegramRuntime } from "./runtime.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const STORE_VERSION = 3;
export const TELEGRAM_UPDATE_OFFSET_NAMESPACE = "telegram.update-offsets";
export const TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES = 1_000;

export type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
};

type TelegramUpdateOffsetStore = PluginStateKeyedStore<TelegramUpdateOffsetState>;

let updateOffsetStoreForTest: TelegramUpdateOffsetStore | undefined;

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeTelegramUpdateOffsetAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function openUpdateOffsetStore(env?: NodeJS.ProcessEnv): TelegramUpdateOffsetStore {
  return (
    updateOffsetStoreForTest ??
    getTelegramRuntime().state.openKeyedStore<TelegramUpdateOffsetState>({
      namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
      maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
      ...(env ? { env } : {}),
    })
  );
}

function resolveTelegramUpdateOffsetPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeTelegramUpdateOffsetAccountId(accountId);
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

export type TelegramOffsetRotationReason = "bot-id-changed" | "token-rotated" | "legacy-state";

export type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number;
};

function rotationForToken(
  parsed: TelegramUpdateOffsetState,
  botToken?: string,
): TelegramUpdateOffsetRotationInfo | null {
  const currentBotId = extractBotIdFromToken(botToken);
  if (!currentBotId || parsed.lastUpdateId === null) {
    return null;
  }
  let reason: TelegramOffsetRotationReason | null = null;
  if (parsed.botId === null) {
    reason = "legacy-state";
  } else if (parsed.botId !== currentBotId) {
    reason = "bot-id-changed";
  } else if (parsed.tokenFingerprint === null) {
    reason = "legacy-state";
  } else if (parsed.tokenFingerprint !== fingerprintFromToken(botToken)) {
    reason = "token-rotated";
  }
  return reason
    ? {
        reason,
        previousBotId: parsed.botId,
        currentBotId,
        staleLastUpdateId: parsed.lastUpdateId,
      }
    : null;
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
  onRotationDetected?: (info: TelegramUpdateOffsetRotationInfo) => void | Promise<void>;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const key = normalizeTelegramUpdateOffsetAccountId(params.accountId);
  let storedValue: unknown;
  try {
    storedValue = await openUpdateOffsetStore(params.env).lookup(key);
  } catch {
    storedValue = undefined;
  }
  const legacyValue = (await readJsonFileWithFallback<unknown>(filePath, null)).value;
  const candidates = [safeParseState(storedValue), safeParseState(legacyValue)].filter(
    (candidate): candidate is TelegramUpdateOffsetState => Boolean(candidate),
  );
  const compatibleCandidates = candidates.filter(
    (candidate) => !rotationForToken(candidate, params.botToken),
  );
  const parsed = (compatibleCandidates.length > 0 ? compatibleCandidates : candidates).toSorted(
    (left, right) => (right.lastUpdateId ?? -1) - (left.lastUpdateId ?? -1),
  )[0];
  if (!parsed) {
    return null;
  }
  const rotation = rotationForToken(parsed, params.botToken);
  if (rotation) {
    await params.onRotationDetected?.(rotation);
    return null;
  }
  return parsed.lastUpdateId;
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
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
    tokenFingerprint: fingerprintFromToken(params.botToken),
  };
  try {
    await openUpdateOffsetStore(params.env).register(
      normalizeTelegramUpdateOffsetAccountId(params.accountId),
      payload,
    );
    await fs.unlink(resolveTelegramUpdateOffsetPath(params.accountId, params.env)).catch((err) => {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        throw err;
      }
    });
  } catch {
    await writeJsonFileAtomically(
      resolveTelegramUpdateOffsetPath(params.accountId, params.env),
      payload,
    );
  }
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  let storeDeleteError: unknown;
  try {
    await openUpdateOffsetStore(params.env).delete(
      normalizeTelegramUpdateOffsetAccountId(params.accountId),
    );
  } catch (err) {
    storeDeleteError = err;
  }
  let legacyDeleteError: unknown;
  try {
    await fs.unlink(resolveTelegramUpdateOffsetPath(params.accountId, params.env));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      legacyDeleteError = err;
    }
  }
  if (storeDeleteError) {
    throw storeDeleteError;
  }
  if (legacyDeleteError) {
    throw legacyDeleteError;
  }
}

export function setTelegramUpdateOffsetStoreForTest(
  store: TelegramUpdateOffsetStore | undefined,
): void {
  updateOffsetStoreForTest = store;
}

export async function listTelegramLegacyUpdateOffsetEntries(params: {
  accountId?: string;
  persistedPath: string;
}): Promise<Array<{ key: string; value: TelegramUpdateOffsetState }>> {
  const { value } = await readJsonFileWithFallback<unknown>(params.persistedPath, null);
  const parsed = safeParseState(value);
  if (!parsed || parsed.lastUpdateId === null) {
    return [];
  }
  return [{ key: normalizeTelegramUpdateOffsetAccountId(params.accountId), value: parsed }];
}
