import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const STORE_VERSION = 3;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  completedUpdateId: number | null;
  botId: string | null;
};

export type TelegramUpdateOffsetSnapshot = {
  lastUpdateId: number | null;
  completedUpdateId: number | null;
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

function parseUpdateIdField(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return isValidUpdateId(value) ? value : undefined;
}

function safeParseState(raw: string): TelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      lastUpdateId?: number | null;
      completedUpdateId?: number | null;
      botId?: string | null;
    };
    if (parsed?.version !== STORE_VERSION && parsed?.version !== 2 && parsed?.version !== 1) {
      return null;
    }
    const lastUpdateId = parseUpdateIdField(parsed.lastUpdateId);
    if (lastUpdateId === undefined) {
      return null;
    }
    const completedUpdateId =
      parsed.version === STORE_VERSION
        ? parseUpdateIdField(parsed.completedUpdateId ?? null)
        : lastUpdateId;
    if (completedUpdateId === undefined) {
      return null;
    }
    if (lastUpdateId !== null && completedUpdateId !== null && completedUpdateId > lastUpdateId) {
      return null;
    }
    if (parsed.version !== 1 && parsed.botId !== null && typeof parsed.botId !== "string") {
      return null;
    }
    return {
      version: STORE_VERSION,
      lastUpdateId,
      completedUpdateId,
      botId: parsed.version === 1 ? null : (parsed.botId ?? null),
    };
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffsetState(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramUpdateOffsetSnapshot> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = safeParseState(raw);
    const expectedBotId = extractBotIdFromToken(params.botToken);
    if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
      return { lastUpdateId: null, completedUpdateId: null };
    }
    if (expectedBotId && parsed?.botId === null) {
      return { lastUpdateId: null, completedUpdateId: null };
    }
    return {
      lastUpdateId: parsed?.lastUpdateId ?? null,
      completedUpdateId: parsed?.completedUpdateId ?? null,
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { lastUpdateId: null, completedUpdateId: null };
    }
    return { lastUpdateId: null, completedUpdateId: null };
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  return (await readTelegramUpdateOffsetState(params)).lastUpdateId;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  completedUpdateId?: number | null;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUpdateId(params.updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }
  const completedUpdateId =
    params.completedUpdateId === undefined ? params.updateId : params.completedUpdateId;
  if (completedUpdateId !== null && !isValidUpdateId(completedUpdateId)) {
    throw new Error("Telegram completed update offset must be a non-negative safe integer.");
  }
  if (completedUpdateId !== null && completedUpdateId > params.updateId) {
    throw new Error("Telegram completed update offset cannot exceed accepted update offset.");
  }
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    completedUpdateId,
    botId: extractBotIdFromToken(params.botToken),
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
