import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const STORE_VERSION = 2;
const UPDATE_OFFSET_STORE = createPluginStateKeyedStore<TelegramUpdateOffsetState>("telegram", {
  namespace: "update-offsets",
  maxEntries: 1_000,
});

export type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
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

function safeParseState(parsed: unknown): TelegramUpdateOffsetState | null {
  try {
    const state = parsed as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
    };
    if (state?.version !== STORE_VERSION && state?.version !== 1) {
      return null;
    }
    if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) {
      return null;
    }
    if (
      state.version === STORE_VERSION &&
      state.botId !== null &&
      typeof state.botId !== "string"
    ) {
      return null;
    }
    return {
      version: STORE_VERSION,
      lastUpdateId: state.lastUpdateId ?? null,
      botId: state.version === STORE_VERSION ? (state.botId ?? null) : null,
    };
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const value = await UPDATE_OFFSET_STORE.lookup(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
  );
  const parsed = safeParseState(value);
  const expectedBotId = extractBotIdFromToken(params.botToken);
  if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
    return null;
  }
  if (expectedBotId && parsed?.botId === null) {
    return null;
  }
  return parsed?.lastUpdateId ?? null;
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
