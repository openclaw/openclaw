import { createHash } from "node:crypto";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";

// Detect token rotation without storing the secret: BotFather /revoke changes
// the token while preserving its bot user ID.
export function fingerprintTelegramBotToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function fingerprintOptionalTelegramBotToken(token?: string): string | null {
  const trimmed = token?.trim();
  return trimmed ? fingerprintTelegramBotToken(trimmed) : null;
}

export function resolveTelegramBotUserIdFromToken(token?: string): number | undefined {
  const rawBotId = token?.trim().split(":", 1)[0];
  return rawBotId && /^\d+$/.test(rawBotId) ? parseStrictPositiveInteger(rawBotId) : undefined;
}
