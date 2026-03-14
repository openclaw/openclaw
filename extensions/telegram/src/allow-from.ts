export function normalizeTelegramAllowFromEntry(raw: unknown): string {
  const base = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return base
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function isNumericTelegramUserId(raw: string): boolean {
  return /^-?\d+$/.test(raw);
}
