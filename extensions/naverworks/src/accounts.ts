import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { NaverWorksAccount, NaverWorksStickerRef } from "./types.js";

const DEFAULT_STATUS_STICKERS: Required<NonNullable<NaverWorksAccount["statusStickers"]>> = {
  enabled: true,
  received: { packageId: "789", stickerId: "10855" },
  processing: { packageId: "534", stickerId: "2429" },
  failed: { packageId: "1", stickerId: "3" },
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry ?? "").trim()))
    .filter((entry) => entry.length > 0);
}

function asThinkingLevel(value: unknown): "low" | "medium" | "high" | undefined {
  const level = asString(value)?.toLowerCase();
  if (level === "low" || level === "medium" || level === "high") {
    return level;
  }
  return undefined;
}

function asStickerRef(value: unknown): NaverWorksStickerRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const packageId = asString(record.packageId);
  const stickerId = asString(record.stickerId);
  if (!packageId || !stickerId) {
    return undefined;
  }
  return { packageId, stickerId };
}

function normalizePrivateKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\\n/g, "\n");
}

export function listAccountIds(cfg: Record<string, unknown>): string[] {
  const section = ((cfg as any)?.channels?.naverworks ?? {}) as Record<string, unknown>;
  const accounts = (section.accounts ?? {}) as Record<string, unknown>;
  const ids = Object.keys(accounts);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): NaverWorksAccount {
  const resolvedId = (accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  const section = ((cfg as any)?.channels?.naverworks ?? {}) as Record<string, unknown>;
  const accounts = (section.accounts ?? {}) as Record<string, unknown>;
  const accountCfg = (accounts[resolvedId] ?? {}) as Record<string, unknown>;
  const sectionAutoThinking = (section.autoThinking ?? {}) as Record<string, unknown>;
  const accountAutoThinking = (accountCfg.autoThinking ?? {}) as Record<string, unknown>;
  const sectionStatusStickers = (section.statusStickers ?? {}) as Record<string, unknown>;
  const accountStatusStickers = (accountCfg.statusStickers ?? {}) as Record<string, unknown>;

  const dmPolicy =
    (asString(accountCfg.dmPolicy) as NaverWorksAccount["dmPolicy"] | undefined) ??
    (asString(section.dmPolicy) as NaverWorksAccount["dmPolicy"] | undefined) ??
    "pairing";

  return {
    accountId: resolvedId,
    enabled:
      (accountCfg.enabled as boolean | undefined) ??
      (section.enabled as boolean | undefined) ??
      true,
    webhookPath:
      asString(accountCfg.webhookPath) ??
      asString(section.webhookPath) ??
      `/naverworks/${resolvedId}/events`,
    dmPolicy,
    allowFrom: [...asStringList(section.allowFrom), ...asStringList(accountCfg.allowFrom)],
    botName: asString(accountCfg.botName) ?? asString(section.botName) ?? "NAVER WORKS Bot",
    strictBinding:
      (accountCfg.strictBinding as boolean | undefined) ??
      (section.strictBinding as boolean | undefined) ??
      true,
    botSecret: asString(accountCfg.botSecret) ?? asString(section.botSecret),
    botId: asString(accountCfg.botId) ?? asString(section.botId),
    accessToken: asString(accountCfg.accessToken) ?? asString(section.accessToken),
    clientId: asString(accountCfg.clientId) ?? asString(section.clientId),
    clientSecret: asString(accountCfg.clientSecret) ?? asString(section.clientSecret),
    serviceAccount: asString(accountCfg.serviceAccount) ?? asString(section.serviceAccount),
    privateKey: normalizePrivateKey(
      asString(accountCfg.privateKey) ?? asString(section.privateKey),
    ),
    scope: asString(accountCfg.scope) ?? asString(section.scope) ?? "bot",
    tokenUrl:
      asString(accountCfg.tokenUrl) ??
      asString(section.tokenUrl) ??
      "https://auth.worksmobile.com/oauth2/v2.0/token",
    jwtIssuer:
      asString(accountCfg.jwtIssuer) ?? asString(section.jwtIssuer) ?? asString(section.clientId),
    apiBaseUrl:
      asString(accountCfg.apiBaseUrl) ??
      asString(section.apiBaseUrl) ??
      "https://www.worksapis.com/v1.0",
    markdownMode:
      (asString(accountCfg.markdownMode) as NaverWorksAccount["markdownMode"] | undefined) ??
      (asString(section.markdownMode) as NaverWorksAccount["markdownMode"] | undefined) ??
      "auto-flex",
    markdownTheme:
      (asString(accountCfg.markdownTheme) as NaverWorksAccount["markdownTheme"] | undefined) ??
      (asString(section.markdownTheme) as NaverWorksAccount["markdownTheme"] | undefined) ??
      "auto",
    autoThinking: {
      enabled:
        (accountAutoThinking.enabled as boolean | undefined) ??
        (sectionAutoThinking.enabled as boolean | undefined) ??
        false,
      defaultLevel:
        asThinkingLevel(accountAutoThinking.defaultLevel) ??
        asThinkingLevel(sectionAutoThinking.defaultLevel),
      lowKeywords: [
        ...asStringList(sectionAutoThinking.lowKeywords),
        ...asStringList(accountAutoThinking.lowKeywords),
      ],
      highKeywords: [
        ...asStringList(sectionAutoThinking.highKeywords),
        ...asStringList(accountAutoThinking.highKeywords),
      ],
    },
    statusStickers: {
      enabled:
        (accountStatusStickers.enabled as boolean | undefined) ??
        (sectionStatusStickers.enabled as boolean | undefined) ??
        true,
      received:
        asStickerRef(accountStatusStickers.received) ??
        asStickerRef(sectionStatusStickers.received) ??
        DEFAULT_STATUS_STICKERS.received,
      processing:
        asStickerRef(accountStatusStickers.processing) ??
        asStickerRef(sectionStatusStickers.processing) ??
        DEFAULT_STATUS_STICKERS.processing,
      failed:
        asStickerRef(accountStatusStickers.failed) ??
        asStickerRef(sectionStatusStickers.failed) ??
        DEFAULT_STATUS_STICKERS.failed,
    },
  };
}
