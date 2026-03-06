import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk";
import { getTypeXClient } from "./client.js";
import { processTypeXMessage } from "./message.js";
import { getTypeXRuntime } from "./runtime.js";

export type MonitorTypeXOpts = {
  account: unknown; // ResolvedTypeXAccount + extras from gateway
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: unknown;
  typexCfg: Record<string, any>;
  /** Full OpenClaw gateway config (needed for bindings/routing). */
  cfg: OpenClawConfig;
};

type TypeXPosState = {
  version: 1;
  lastPos: number;
  accountId: string;
};

const POS_STORE_VERSION = 1;

const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");

function normalizeAccountIdForFile(accountId: string): string {
  return (accountId || "default").replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveTypeXPosStatePath(accountId: string): string {
  const stateDir = getTypeXRuntime().state.resolveStateDir(process.env, os.homedir);
  const normalized = normalizeAccountIdForFile(accountId);
  return path.join(stateDir, "typex", `update-pos-${normalized}.json`);
}

function parseTypeXPosState(raw: string): TypeXPosState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TypeXPosState>;
    if (parsed.version !== POS_STORE_VERSION) {
      return null;
    }
    if (
      typeof parsed.lastPos !== "number" ||
      !Number.isFinite(parsed.lastPos) ||
      parsed.lastPos < 0
    ) {
      return null;
    }
    if (typeof parsed.accountId !== "string" || !parsed.accountId.trim()) {
      return null;
    }
    return {
      version: POS_STORE_VERSION,
      lastPos: parsed.lastPos,
      accountId: parsed.accountId,
    };
  } catch {
    return null;
  }
}

async function readPosFromState(accountId: string): Promise<number | null> {
  const filePath = resolveTypeXPosStatePath(accountId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = parseTypeXPosState(raw);
    if (!parsed) {
      return null;
    }
    // Guard against accidental account file reuse.
    if (parsed.accountId !== accountId) {
      return null;
    }
    return parsed.lastPos;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writePosToState(accountId: string, pos: number): Promise<void> {
  const filePath = resolveTypeXPosStatePath(accountId);
  const payload: TypeXPosState = {
    version: POS_STORE_VERSION,
    lastPos: pos,
    accountId,
  };
  await writeJsonFileAtomically(filePath, payload);
}

async function readPosFromConfig(params: {
  accountId: string;
  channelKey: "typex" | "openclaw-extension-typex";
}): Promise<number | null> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const pos = cfg?.channels?.[params.channelKey]?.accounts?.[params.accountId]?.pos;
    if (typeof pos === "number" && Number.isFinite(pos) && pos >= 0) {
      return pos;
    }
  } catch {
    // ignore
  }
  return null;
}

async function readLegacyPosFile(accountId: string): Promise<number | null> {
  // Legacy state file locations (pre-state-dir storage):
  //   v1 (oldest): /tmp/typex/.typex_pos_<safeId>.json
  //   v2:          /tmp/typex/<accountId>/.typex_pos.json
  const safeId = normalizeAccountIdForFile(accountId);
  const legacyCandidates = [
    path.join("/tmp", "typex", `.typex_pos_${safeId}.json`),
    path.join("/tmp", "typex", accountId, ".typex_pos.json"),
  ];

  for (const candidate of legacyCandidates) {
    try {
      const data = await fs.readFile(candidate, "utf-8");
      const json = JSON.parse(data) as { pos?: unknown };
      if (typeof json.pos === "number" && Number.isFinite(json.pos) && json.pos >= 0) {
        await fs.unlink(candidate).catch(() => {
          // best effort cleanup
        });
        return json.pos;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

/**
 * Read TypeX stream position.
 * Priority:
 * 1) state dir (new)
 * 2) channels.typex.accounts.<id>.pos (legacy in-config)
 * 3) channels.openclaw-extension-typex.accounts.<id>.pos (old plugin id)
 * 4) /tmp/typex legacy files
 */
async function readPos(accountId: string): Promise<number> {
  const statePos = await readPosFromState(accountId);
  if (typeof statePos === "number") {
    return statePos;
  }

  const migrationCandidates: Array<() => Promise<number | null>> = [
    () => readPosFromConfig({ accountId, channelKey: "typex" }),
    () => readPosFromConfig({ accountId, channelKey: "openclaw-extension-typex" }),
    () => readLegacyPosFile(accountId),
  ];

  for (const candidate of migrationCandidates) {
    const pos = await candidate();
    if (typeof pos === "number") {
      await writePosToState(accountId, pos).catch(() => {
        // non-fatal; fallback to using runtime pos only
      });
      return pos;
    }
  }

  return 0;
}

async function savePos(accountId: string, pos: number): Promise<void> {
  try {
    await writePosToState(accountId, pos);
  } catch {
    // Non-fatal: losing pos means re-processing a few messages at worst.
  }
}

export async function monitorTypeXProvider(opts: MonitorTypeXOpts) {
  try {
    const { account, runtime, abortSignal, log, typexCfg, cfg } = opts;
    const accountObj = account as {
      config: { token?: string; appId?: string };
      accountId: string;
      name?: string;
    };
    const { token, appId } = accountObj.config;
    const logger = log as
      | { warn: (msg: string) => void; info: (msg: string) => void; error: (msg: string) => void }
      | undefined;

    if (!token) {
      logger?.warn(`[${accountObj.accountId}] No token found. Stopping monitor.`);
      return;
    }

    const client = getTypeXClient(undefined, { token, skipConfigCheck: true });

    logger?.info(`[${accountObj.accountId}] Starting TypeX monitor for ${accountObj.accountId}...`);

    let currentPos = await readPos(accountObj.accountId);
    logger?.info(`[${accountObj.accountId}] Loaded pos: ${currentPos}`);

    while (!abortSignal.aborted) {
      try {
        const messages = await client.fetchMessages(currentPos);

        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const nextPos =
              typeof msg.position === "number" && Number.isFinite(msg.position) && msg.position >= 0
                ? msg.position
                : null;
            try {
              await processTypeXMessage(client, msg, appId || accountObj.accountId, {
                accountId: accountObj.accountId,
                cfg,
                typexCfg,
                botName: accountObj.name,
                logger,
              });
            } catch (err) {
              logger?.error(
                `[${accountObj.accountId}] processTypeXMessage failed: ${
                  err instanceof Error ? err.stack : String(err)
                }`,
              );
            } finally {
              if (typeof nextPos === "number") {
                currentPos = nextPos;
                await savePos(accountObj.accountId, currentPos);
              }
            }
          }
        }
      } catch (err) {
        logger?.error(
          `Error in TypeX polling loop: ${err instanceof Error ? err.stack : String(err)}`,
        );
      }

      if (abortSignal.aborted) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    logger?.info("Stopping TypeX monitor...");
  } catch (e) {
    throw e;
  }
}
