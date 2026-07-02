import { normalizeWhatsAppAllowFromEntry } from "./normalize.js";

export const WHATSAPP_ALLOW_FROM_GROUPS = [
  "trusted",
  "partner",
  "friends",
  "family",
  "work",
  "restricted",
] as const;

export const DEFAULT_WHATSAPP_ALLOW_FROM_GROUP = "restricted" satisfies WhatsAppAllowFromGroup;

export type WhatsAppAllowFromGroup = (typeof WHATSAPP_ALLOW_FROM_GROUPS)[number];

export type WhatsAppGroupedAllowFromEntry = {
  number: string;
  group: WhatsAppAllowFromGroup;
};

export type WhatsAppAllowFromEntry = string | WhatsAppGroupedAllowFromEntry;

const WHATSAPP_ALLOW_FROM_GROUP_SET = new Set<string>(WHATSAPP_ALLOW_FROM_GROUPS);

export function isWhatsAppAllowFromGroup(value: string): value is WhatsAppAllowFromGroup {
  return WHATSAPP_ALLOW_FROM_GROUP_SET.has(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readWhatsAppAllowFromEntryNumber(entry: unknown): string | undefined {
  if (typeof entry === "string" || typeof entry === "number") {
    const value = String(entry).trim();
    return value || undefined;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  return readStringField(entry as Record<string, unknown>, "number");
}

export function readWhatsAppAllowFromEntryGroup(
  entry: unknown,
): WhatsAppAllowFromGroup | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const group = readStringField(entry as Record<string, unknown>, "group");
  return group && isWhatsAppAllowFromGroup(group) ? group : undefined;
}

export function normalizeWhatsAppAllowFromEntryNumbers(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    const number = readWhatsAppAllowFromEntryNumber(entry);
    if (!number) {
      continue;
    }
    const normalizedEntry = number.startsWith("accessGroup:")
      ? number
      : normalizeWhatsAppAllowFromEntry(number);
    if (!normalizedEntry || seen.has(normalizedEntry)) {
      continue;
    }
    seen.add(normalizedEntry);
    normalized.push(normalizedEntry);
  }
  return normalized;
}

export function createWhatsAppAllowFromEntry(params: {
  number: string;
  group: WhatsAppAllowFromGroup;
}): WhatsAppGroupedAllowFromEntry {
  return {
    number: params.number.trim(),
    group: params.group,
  };
}

export function resolveWhatsAppAllowFromSenderGroup(params: {
  allowFrom: readonly unknown[];
  senderId?: string | null;
}): WhatsAppAllowFromGroup | undefined {
  const sender = params.senderId?.trim();
  if (!sender) {
    return undefined;
  }
  const normalizedSender = normalizeWhatsAppAllowFromEntry(sender);
  if (!normalizedSender) {
    return undefined;
  }
  for (const entry of params.allowFrom) {
    const group = readWhatsAppAllowFromEntryGroup(entry);
    if (!group) {
      continue;
    }
    const number = readWhatsAppAllowFromEntryNumber(entry);
    const normalizedEntry = number ? normalizeWhatsAppAllowFromEntry(number) : null;
    if (normalizedEntry === normalizedSender) {
      return group;
    }
  }
  return undefined;
}
