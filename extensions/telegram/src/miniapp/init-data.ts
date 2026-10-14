import crypto from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";

const INIT_DATA_MAX_AGE_MS = 300_000;

type TelegramMiniAppInitData = {
  hash: string;
  authDateMs: number;
  userId: string;
};

export function validateTelegramMiniAppInitData(params: {
  initData: string;
  botToken: string;
  nowMs?: number;
}): TelegramMiniAppInitData | null {
  const initData = params.initData.trim();
  const botToken = params.botToken.trim();
  if (!initData || !botToken) {
    return null;
  }

  const parsed = new URLSearchParams(initData);
  const receivedHash = parsed.get("hash")?.trim() ?? "";
  const authDateRaw = parsed.get("auth_date")?.trim() ?? "";
  const userRaw = parsed.get("user")?.trim() ?? "";
  if (!receivedHash || !authDateRaw || !userRaw) {
    return null;
  }

  const authDateSeconds = Number(authDateRaw);
  if (!Number.isInteger(authDateSeconds) || authDateSeconds <= 0) {
    return null;
  }
  const authDateMs = authDateSeconds * 1000;
  const ageMs = (params.nowMs ?? Date.now()) - authDateMs;
  if (ageMs < 0 || ageMs > INIT_DATA_MAX_AGE_MS) {
    return null;
  }

  const entries = [...parsed.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .toSorted();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secret).update(entries.join("\n")).digest("hex");
  if (!safeEqualSecret(computedHash, receivedHash)) {
    return null;
  }

  try {
    const user = JSON.parse(userRaw) as { id?: unknown };
    const userId =
      typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0
        ? String(user.id)
        : typeof user.id === "string" && /^\d+$/.test(user.id)
          ? user.id
          : null;
    return userId === null ? null : { hash: receivedHash, authDateMs, userId };
  } catch {
    return null;
  }
}
