// Telegram helper module supports normalize behavior.
import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeTelegramLookupTarget, parseTelegramTarget } from "./targets.js";

const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;

function normalizeTelegramTargetBody(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const prefixStripped = trimmed.replace(TELEGRAM_PREFIX_RE, "").trim();
  if (!prefixStripped) {
    return undefined;
  }

  const parsed = parseTelegramTarget(trimmed);
  const normalizedChatId = normalizeTelegramLookupTarget(parsed.chatId);
  if (!normalizedChatId) {
    return undefined;
  }

  const keepLegacyGroupPrefix = /^group:/i.test(prefixStripped);
  const hasTopicSuffix = /:topic:\d+$/i.test(prefixStripped);
  const chatSegment = keepLegacyGroupPrefix ? `group:${normalizedChatId}` : normalizedChatId;
  if (parsed.messageThreadId == null) {
    return chatSegment;
  }
  const threadSuffix = hasTopicSuffix
    ? `:topic:${parsed.messageThreadId}`
    : `:${parsed.messageThreadId}`;
  return `${chatSegment}${threadSuffix}`;
}

export function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const normalizedBody = normalizeTelegramTargetBody(raw);
  if (!normalizedBody) {
    return undefined;
  }
  return normalizeLowercaseStringOrEmpty(`telegram:${normalizedBody}`);
}

export function looksLikeTelegramTargetId(raw: string): boolean {
  return normalizeTelegramTargetBody(raw) !== undefined;
}

function readOptionalLocationText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeTelegramOutboundLocation(value: unknown): NormalizedLocation | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("location must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const latitude = raw.latitude;
  const longitude = raw.longitude;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error("location.latitude must be a finite number between -90 and 90.");
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("location.longitude must be a finite number between -180 and 180.");
  }
  const accuracy = raw.accuracy;
  if (
    accuracy !== undefined &&
    (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1500)
  ) {
    throw new Error("location.accuracy must be a finite number between 0 and 1500.");
  }
  const source = raw.source;
  if (source !== undefined && source !== "pin" && source !== "place" && source !== "live") {
    throw new Error("location.source must be pin, place, or live.");
  }
  const isLive = raw.isLive;
  if (isLive !== undefined && typeof isLive !== "boolean") {
    throw new Error("location.isLive must be a boolean.");
  }
  const name = readOptionalLocationText(raw.name);
  const address = readOptionalLocationText(raw.address);
  const caption = readOptionalLocationText(raw.caption);
  return {
    latitude,
    longitude,
    ...(accuracy !== undefined ? { accuracy } : {}),
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(isLive !== undefined ? { isLive } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(caption ? { caption } : {}),
  };
}
