export const TELEGRAM_ALLOW_FROM_GROUPS = [
  "trusted",
  "partner",
  "friends",
  "family",
  "work",
  "restricted",
] as const;

export const DEFAULT_TELEGRAM_ALLOW_FROM_GROUP =
  "restricted" satisfies TelegramAllowFromGroup;

export type TelegramAllowFromGroup = (typeof TELEGRAM_ALLOW_FROM_GROUPS)[number];

export type TelegramGroupedAllowFromEntry = {
  number: string | number;
  group: TelegramAllowFromGroup;
};

export type TelegramAllowFromEntry = string | number | TelegramGroupedAllowFromEntry;

const TELEGRAM_ALLOW_FROM_GROUP_SET = new Set<string>(TELEGRAM_ALLOW_FROM_GROUPS);

export function isTelegramAllowFromGroup(value: string): value is TelegramAllowFromGroup {
  return TELEGRAM_ALLOW_FROM_GROUP_SET.has(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function readTelegramAllowFromEntryNumber(raw: unknown): string | undefined {
  if (typeof raw === "string" || typeof raw === "number") {
    const value = String(raw).trim();
    return value || undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return readStringField(raw as Record<string, unknown>, "number");
}

export function readTelegramAllowFromEntryGroup(
  raw: unknown,
): TelegramAllowFromGroup | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const group = readStringField(raw as Record<string, unknown>, "group");
  return group && isTelegramAllowFromGroup(group) ? group : undefined;
}

export function normalizeTelegramAllowFromEntry(raw: unknown): string {
  const base = readTelegramAllowFromEntryNumber(raw) ?? "";
  return base
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function normalizeTelegramAllowFromEntries(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    const value = normalizeTelegramAllowFromEntry(entry);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function createTelegramAllowFromEntry(params: {
  number: string;
  group: TelegramAllowFromGroup;
}): TelegramGroupedAllowFromEntry {
  return {
    number: params.number.trim(),
    group: params.group,
  };
}

export function resolveTelegramAllowFromSenderGroup(params: {
  allowFrom: readonly unknown[];
  senderId?: string | null;
}): TelegramAllowFromGroup | undefined {
  const sender = normalizeTelegramAllowFromEntry(params.senderId);
  if (!sender) {
    return undefined;
  }
  for (const entry of params.allowFrom) {
    const group = readTelegramAllowFromEntryGroup(entry);
    if (!group) {
      continue;
    }
    if (normalizeTelegramAllowFromEntry(entry) === sender) {
      return group;
    }
  }
  return undefined;
}

export function isNumericTelegramUserId(raw: string): boolean {
  return /^-?\d+$/.test(raw);
}

// Telegram sender authorization only accepts concrete user IDs. Negative chat IDs
// belong under `channels.telegram.groups`, not sender allowlists.
export function isNumericTelegramSenderUserId(raw: string): boolean {
  return /^\d+$/.test(raw);
}
