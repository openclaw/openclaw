import { randomBytes } from "node:crypto";

const PAIRING_TTL_MS = 10 * 60 * 1000;

export type DailyflowsPairingEntry = {
  pairCode: string;
  gatewayUrl: string;
  accountId: string;
  payload: string;
  createdAt: number;
  expiresAt: number;
};

const PAIRINGS = new Map<string, DailyflowsPairingEntry>();

function cleanupExpired() {
  const now = Date.now();
  for (const [code, entry] of PAIRINGS.entries()) {
    if (entry.expiresAt <= now) {
      PAIRINGS.delete(code);
    }
  }
}

export function normalizeGatewayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function createDailyflowsPairing(params: {
  gatewayUrl: string;
  accountId?: string | null;
}): DailyflowsPairingEntry {
  cleanupExpired();
  const pairCode = randomBytes(16).toString("hex");
  const accountId = params.accountId?.trim() || "default";
  const payload = JSON.stringify({
    type: "openclaw.dailyflows.pair",
    version: 1,
    gatewayUrl: params.gatewayUrl,
    pairCode,
    accountId,
  });
  const createdAt = Date.now();
  const entry: DailyflowsPairingEntry = {
    pairCode,
    gatewayUrl: params.gatewayUrl,
    accountId,
    payload,
    createdAt,
    expiresAt: createdAt + PAIRING_TTL_MS,
  };
  PAIRINGS.set(pairCode, entry);
  return entry;
}

export function consumeDailyflowsPairing(pairCode: string): DailyflowsPairingEntry | null {
  cleanupExpired();
  const entry = PAIRINGS.get(pairCode);
  if (!entry) {
    return null;
  }
  PAIRINGS.delete(pairCode);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry;
}
