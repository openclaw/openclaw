import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getTelegramRuntime } from "./runtime.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import {
  fingerprintTelegramBotToken,
  resolveTelegramBotUserIdFromToken,
} from "./token-fingerprint.js";

const STORE_VERSION = 3;
const TELEGRAM_UPDATE_OFFSET_NAMESPACE = "telegram.update-offsets";
const TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES = 1_000;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
};

type TelegramUpdateOffsetStore = PluginStateKeyedStore<TelegramUpdateOffsetState>;

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function openUpdateOffsetStore(env?: NodeJS.ProcessEnv): TelegramUpdateOffsetStore {
  return getTelegramRuntime().state.openKeyedStore<TelegramUpdateOffsetState>({
    namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
    maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function extractBotIdFromToken(token?: string): string | null {
  const botUserId = resolveTelegramBotUserIdFromToken(token);
  return botUserId === undefined ? null : String(botUserId);
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

type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number;
};

export type TelegramAccountRotationInfo = Omit<
  TelegramUpdateOffsetRotationInfo,
  "staleLastUpdateId"
> & {
  staleLastUpdateId: number | null;
};

function rotationForToken(
  parsed: TelegramUpdateOffsetState,
  botToken?: string,
): TelegramAccountRotationInfo | null {
  const currentBotId = extractBotIdFromToken(botToken);
  if (!currentBotId) {
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
  const key = normalizeTelegramStateAccountId(params.accountId);
  let storedValue: unknown;
  try {
    storedValue = await openUpdateOffsetStore(params.env).lookup(key);
  } catch {
    storedValue = undefined;
  }
  const parsed = safeParseState(storedValue);
  if (!parsed) {
    return null;
  }
  const rotation = rotationForToken(parsed, params.botToken);
  if (rotation) {
    if (rotation.staleLastUpdateId !== null) {
      await params.onRotationDetected?.({
        ...rotation,
        staleLastUpdateId: rotation.staleLastUpdateId,
      });
    }
    return null;
  }
  return parsed.lastUpdateId;
}

export async function prepareTelegramAccount(params: {
  accountId: string;
  botToken: string;
  abortSignal?: AbortSignal;
  onRotationDetected: (info: TelegramAccountRotationInfo) => void;
}): Promise<number | null> {
  const accountId = normalizeTelegramStateAccountId(params.accountId);
  try {
    const store = openUpdateOffsetStore();
    const parsed = safeParseState(await store.lookup(accountId));
    const rotation = parsed ? rotationForToken(parsed, params.botToken) : null;
    if (rotation) {
      params.onRotationDetected(rotation);
      if (rotation.previousBotId !== null && rotation.previousBotId !== rotation.currentBotId) {
        const queue = getTelegramRuntime().state.openChannelIngressQueue({ accountId });
        if (!queue.purge) {
          throw new Error("The host does not support ingress identity resets; update OpenClaw.");
        }
        params.abortSignal?.throwIfAborted();
        await queue.purge();
      }
    }
    params.abortSignal?.throwIfAborted();
    if (!parsed || rotation) {
      // Keep the old identity until purge commits, then replace it without an absent-marker window.
      // Webhook-only accounts need this marker even though they have no polling cursor.
      await store.register(accountId, {
        version: STORE_VERSION,
        lastUpdateId: null,
        botId: extractBotIdFromToken(params.botToken),
        tokenFingerprint: fingerprintFromToken(params.botToken),
      });
    }
    return rotation ? null : (parsed?.lastUpdateId ?? null);
  } catch (err) {
    throw new Error(
      `telegram: failed to prepare ingress for account "${accountId}"; restart the account to retry: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
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
  await openUpdateOffsetStore(params.env).register(
    normalizeTelegramStateAccountId(params.accountId),
    payload,
  );
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await openUpdateOffsetStore(params.env).delete(normalizeTelegramStateAccountId(params.accountId));
}
