export type TelegramProSource = "PRO_ALL" | "PRO_USERS" | "none";

export function resolveTelegramProSource(userId: number): TelegramProSource {
  const proAll = (process.env.OPENCLAW_TELEGRAM_PRO_ALL ?? "").trim().toLowerCase();
  if (proAll === "1" || proAll === "true" || proAll === "yes") {
    return "PRO_ALL";
  }

  if (!Number.isFinite(userId) || userId <= 0) {
    return "none";
  }

  const raw = (process.env.OPENCLAW_TELEGRAM_PRO_USERS ?? "").trim();
  if (!raw) {
    return "none";
  }
  if (raw === "*") {
    return "PRO_USERS";
  }

  const proUsers = raw
    .split(/[,\s;|]+/)
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
  return proUsers.includes(userId) ? "PRO_USERS" : "none";
}

export function resolveTelegramProStatus(userId: number): boolean {
  return resolveTelegramProSource(userId) !== "none";
}

export function formatTelegramAuthBadge(isProUser: boolean): string {
  return isProUser ? "⭐ Pro" : "🆓 Free";
}

export function resolveTelegramAuthBadge(userId: number): string {
  return formatTelegramAuthBadge(resolveTelegramProStatus(userId));
}
