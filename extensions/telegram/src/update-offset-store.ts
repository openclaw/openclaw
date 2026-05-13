import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const STORE_VERSION = 2;
const UPDATE_OFFSET_STORE = createPluginStateKeyedStore<TelegramUpdateOffsetState>("telegram", {
  namespace: "update-offsets",
  maxEntries: 1_000,
});

export type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
};

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
  const value = await UPDATE_OFFSET_STORE.lookup(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
  );
  const parsed = safeParseState(value);
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
  await UPDATE_OFFSET_STORE.register(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
    payload,
  );
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await UPDATE_OFFSET_STORE.delete(normalizeTelegramUpdateOffsetAccountId(params.accountId));
}

export async function resetTelegramUpdateOffsetsForTests(): Promise<void> {
  await UPDATE_OFFSET_STORE.clear();
}
