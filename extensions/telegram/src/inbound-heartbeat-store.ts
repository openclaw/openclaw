import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const STORE_VERSION = 1;

// Two outcomes distinguish a real inbound message batch from an empty long-poll
// acknowledgement. Both prove the poll loop is alive and Telegram is reachable,
// which is what an external watchdog actually needs. A stuck long-poll where
// sendMessage still works would stop updating this file — that's the signal.
export type TelegramInboundOutcome = "message" | "empty_ack";

export type TelegramInboundHeartbeat = {
  version: number;
  accountId: string;
  botId: string | null;
  ts: number;
  isoTs: string;
  outcome: TelegramInboundOutcome;
  updateCount: number;
  lastUpdateId: number | null;
  source: "getUpdates";
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function extractBotIdFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  const [rawBotId] = trimmed.split(":", 1);
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    return null;
  }
  return rawBotId;
}

export function resolveTelegramInboundHeartbeatPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `last-inbound-${normalized}.json`);
}

export async function writeTelegramInboundHeartbeat(params: {
  accountId?: string;
  botToken?: string;
  outcome: TelegramInboundOutcome;
  updateCount: number;
  lastUpdateId?: number | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<void> {
  if (params.outcome !== "message" && params.outcome !== "empty_ack") {
    throw new Error(`Unexpected telegram inbound outcome: ${String(params.outcome)}`);
  }
  if (
    typeof params.updateCount !== "number" ||
    !Number.isFinite(params.updateCount) ||
    params.updateCount < 0
  ) {
    throw new Error("updateCount must be a finite non-negative number.");
  }
  const filePath = resolveTelegramInboundHeartbeatPath(params.accountId, params.env);
  const ts = (params.now ?? Date.now)();
  const payload: TelegramInboundHeartbeat = {
    version: STORE_VERSION,
    accountId: normalizeAccountId(params.accountId),
    botId: extractBotIdFromToken(params.botToken),
    ts,
    isoTs: new Date(ts).toISOString(),
    outcome: params.outcome,
    updateCount: params.updateCount,
    lastUpdateId:
      typeof params.lastUpdateId === "number" && Number.isSafeInteger(params.lastUpdateId)
        ? params.lastUpdateId
        : null,
    source: "getUpdates",
  };
  await writeJsonFileAtomically(filePath, payload);
}

export async function readTelegramInboundHeartbeat(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramInboundHeartbeat | null> {
  const filePath = resolveTelegramInboundHeartbeatPath(params.accountId, params.env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: Partial<TelegramInboundHeartbeat> | null;
  try {
    parsed = JSON.parse(raw) as Partial<TelegramInboundHeartbeat>;
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== STORE_VERSION) {
    return null;
  }
  if (parsed.outcome !== "message" && parsed.outcome !== "empty_ack") {
    return null;
  }
  if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
    return null;
  }
  if (typeof parsed.updateCount !== "number" || !Number.isFinite(parsed.updateCount)) {
    return null;
  }
  return {
    version: STORE_VERSION,
    accountId: typeof parsed.accountId === "string" ? parsed.accountId : "default",
    botId: typeof parsed.botId === "string" ? parsed.botId : null,
    ts: parsed.ts,
    isoTs: typeof parsed.isoTs === "string" ? parsed.isoTs : new Date(parsed.ts).toISOString(),
    outcome: parsed.outcome,
    updateCount: parsed.updateCount,
    lastUpdateId:
      typeof parsed.lastUpdateId === "number" && Number.isSafeInteger(parsed.lastUpdateId)
        ? parsed.lastUpdateId
        : null,
    source: "getUpdates",
  };
}
