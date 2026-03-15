import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../src/config/paths.js";
import { writeJsonAtomic } from "../../../src/infra/json-files.js";
import { resolveTelegramApiRoot } from "./api-root.js";

const STORE_VERSION = 3;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  apiRoot: string | null;
};

type ParsedTelegramUpdateOffsetState = TelegramUpdateOffsetState & {
  hasApiRootIdentity: boolean;
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

function normalizeApiRootKey(apiRoot?: string | null): string | null {
  const trimmed = apiRoot?.trim();
  if (!trimmed) {
    return null;
  }
  return resolveTelegramApiRoot(trimmed);
}

function safeParseState(raw: string): ParsedTelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
      apiRoot?: string | null;
    };
    if (parsed?.version !== STORE_VERSION && parsed?.version !== 2 && parsed?.version !== 1) {
      return null;
    }
    if (parsed.lastUpdateId !== null && !isValidUpdateId(parsed.lastUpdateId)) {
      return null;
    }
    if (
      parsed.version === STORE_VERSION &&
      parsed.botId !== null &&
      typeof parsed.botId !== "string"
    ) {
      return null;
    }
    if (
      parsed.version === STORE_VERSION &&
      parsed.apiRoot !== null &&
      typeof parsed.apiRoot !== "string"
    ) {
      return null;
    }
    return {
      version: STORE_VERSION,
      lastUpdateId: parsed.lastUpdateId ?? null,
      botId: parsed.version >= 2 ? (parsed.botId ?? null) : null,
      apiRoot: parsed.version === STORE_VERSION ? (parsed.apiRoot ?? null) : null,
      hasApiRootIdentity: parsed.version === STORE_VERSION,
    };
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  apiRoot?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = safeParseState(raw);
    const expectedBotId = extractBotIdFromToken(params.botToken);
    const expectedApiRoot = normalizeApiRootKey(params.apiRoot);
    if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
      return null;
    }
    if (expectedBotId && parsed?.botId === null) {
      return null;
    }
    if (parsed?.hasApiRootIdentity) {
      if (parsed.apiRoot !== expectedApiRoot) {
        return null;
      }
    } else if (expectedApiRoot !== null) {
      return null;
    }
    return parsed?.lastUpdateId ?? null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  apiRoot?: string | null;
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
    apiRoot: normalizeApiRootKey(params.apiRoot),
  };
  await writeJsonAtomic(filePath, payload, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
  });
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
