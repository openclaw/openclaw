/**
 * TTS configuration resolution — extracted from utils/audio-convert.ts.
 *
 * Zero external dependency: the original `asRecord`/`readString` from
 * plugin-sdk are inlined as trivial object helpers.
 */

// ============ Inline helpers (replaces config-record-shared.ts re-exports) ============

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readString(record: unknown, key: string): string | undefined {
  const r = asRecord(record);
  if (!r) {
    return undefined;
  }
  const v = r[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function readStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entryValue]) =>
      typeof entryValue === "string" ? [[key, entryValue]] : [],
    ),
  );
}

// ============ Types ============

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  authStyle?: "bearer" | "api-key";
  queryParams?: Record<string, string>;
  speed?: number;
}

type TtsProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  authStyle?: string;
  queryParams?: Record<string, string>;
};

type TtsBlock = TtsProviderConfig & {
  model?: string;
  voice?: string;
  speed?: number;
};

// ============ Resolution ============

function resolveTTSFromBlock(
  block: TtsBlock,
  providerCfg: TtsProviderConfig | undefined,
): TTSConfig | null {
  const baseUrl = readString(block, "baseUrl") ?? readString(providerCfg, "baseUrl");
  const apiKey = readString(block, "apiKey") ?? readString(providerCfg, "apiKey");
  const model = readString(block, "model") ?? "tts-1";
  const voice = readString(block, "voice") ?? "alloy";
  if (!baseUrl || !apiKey) {
    return null;
  }

  const authStyle =
    (readString(block, "authStyle") ?? readString(providerCfg, "authStyle")) === "api-key"
      ? ("api-key" as const)
      : ("bearer" as const);
  const queryParams: Record<string, string> = {
    ...readStringMap(providerCfg?.queryParams),
    ...readStringMap(block.queryParams),
  };
  const speed = readNumber(block, "speed");

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    voice,
    authStyle,
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

/** Resolve QQBot TTS config from the full openclaw config object. */
export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const models = asRecord(cfg.models);
  const providers = asRecord(models?.providers);

  // Prefer plugin-specific TTS config first.
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  const channelTts = asRecord(qqbot?.tts);
  if (channelTts && channelTts.enabled !== false) {
    const providerId = readString(channelTts, "provider") ?? "openai";
    const providerCfg = asRecord(providers?.[providerId]);
    const result = resolveTTSFromBlock(channelTts, providerCfg);
    if (result) {
      return result;
    }
  }

  // Fall back to framework-level TTS config.
  const messages = asRecord(cfg.messages);
  const msgTts = asRecord(messages?.tts);
  const autoMode = readString(msgTts, "auto");
  if (msgTts && autoMode !== "off" && autoMode !== "disabled") {
    const providerId = readString(msgTts, "provider") ?? "openai";
    const providerBlock = asRecord(msgTts[providerId]) ?? {};
    const providerCfg = asRecord(providers?.[providerId]);
    const result = resolveTTSFromBlock(providerBlock, providerCfg);
    if (result) {
      return result;
    }
  }

  return null;
}

/**
 * Check whether global TTS is potentially available by inspecting
 * the framework-level `messages.tts` config.
 */
export function isGlobalTTSAvailable(cfg: unknown): boolean {
  const root = asRecord(cfg);
  if (!root) {
    return false;
  }
  const messages = asRecord(root.messages);
  const msgTts = asRecord(messages?.tts) as { auto?: string; enabled?: boolean } | undefined;
  if (!msgTts) {
    return false;
  }
  if (msgTts.auto) {
    return msgTts.auto !== "off";
  }
  return msgTts.enabled === true;
}
