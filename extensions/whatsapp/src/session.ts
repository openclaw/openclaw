import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { Agent } from "node:https";
import path from "node:path";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger, toPinoLikeLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import qrcode from "qrcode-terminal";
import {
  maybeRestoreCredsFromBackup,
  readCredsJsonRaw,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
} from "./auth-store.js";
import { formatError, getStatusCode } from "./session-errors.js";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "./session.runtime.js";
export { formatError, getStatusCode } from "./session-errors.js";

export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  readWebSelfId,
  WA_WEB_AUTH_DIR,
  webAuthExists,
} from "./auth-store.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const CREDS_FILE_MODE = 0o600;

// Per-authDir queues so multi-account creds saves don't block each other.
const credsSaveQueues = new Map<string, Promise<void>>();
const CREDS_SAVE_FLUSH_TIMEOUT_MS = 15_000;

function serializeBaileysJson(_key: string, value: unknown) {
  if (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    (typeof value === "object" && value !== null && "type" in value && value.type === "Buffer")
  ) {
    const data =
      typeof value === "object" && value !== null && "data" in value ? value.data : value;
    return { type: "Buffer", data: Buffer.from(data as Uint8Array).toString("base64") };
  }
  return value;
}

async function writeCredsJsonAtomic(authDir: string, creds: unknown): Promise<void> {
  const credsPath = resolveWebCredsPath(authDir);
  const tempPath = path.join(
    path.dirname(credsPath),
    `${path.basename(credsPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(creds, serializeBaileysJson), {
      encoding: "utf-8",
      mode: CREDS_FILE_MODE,
    });
    await fs.rename(tempPath, credsPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {
      // best-effort cleanup for interrupted writes
    });
    throw error;
  }
}

function enqueueSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): void {
  const prev = credsSaveQueues.get(authDir) ?? Promise.resolve();
  const next = prev
    .then(() => safeSaveCreds(authDir, saveCreds, logger))
    .catch((err) => {
      logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
    })
    .finally(() => {
      if (credsSaveQueues.get(authDir) === next) {
        credsSaveQueues.delete(authDir);
      }
    });
  credsSaveQueues.set(authDir, next);
}

async function safeSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): Promise<void> {
  try {
    // Best-effort backup so we can recover after abrupt restarts.
    // Important: don't clobber a good backup with a corrupted/truncated creds.json.
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      try {
        JSON.parse(raw);
        fsSync.copyFileSync(credsPath, backupPath);
        try {
          fsSync.chmodSync(backupPath, 0o600);
        } catch {
          // best-effort on platforms that support it
        }
      } catch {
        // keep existing backup
      }
    }
  } catch {
    // ignore backup failures
  }
  try {
    await Promise.resolve(saveCreds());
    try {
      fsSync.chmodSync(resolveWebCredsPath(authDir), CREDS_FILE_MODE);
    } catch {
      // best-effort on platforms that support it
    }
  } catch (err) {
    logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
  }
}

/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(
  printQr: boolean,
  verbose: boolean,
  opts: { authDir?: string; onQr?: (qr: string) => void } = {},
): Promise<ReturnType<typeof makeWASocket>> {
  const baseLogger = getChildLogger(
    { module: "baileys" },
    {
      level: verbose ? "info" : "silent",
    },
  );
  const logger = toPinoLikeLogger(baseLogger, verbose ? "info" : "silent");
  const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
  await ensureDir(authDir);
  const sessionLogger = getChildLogger({ module: "web-session" });
  maybeRestoreCredsFromBackup(authDir);
  const { state } = await useMultiFileAuthState(authDir);
  const saveCreds = () => writeCredsJsonAtomic(authDir, state.creds);
  const { version } = await fetchLatestBaileysVersion();
  const agent = await resolveEnvProxyAgent(sessionLogger);
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["openclaw", "cli", VERSION],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    agent,
    fetchAgent: agent,
  });

  sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          opts.onQr?.(qr);
          if (printQr) {
            console.log("Scan this QR in WhatsApp (Linked Devices):");
            qrcode.generate(qr, { small: true });
          }
        }
        if (connection === "close") {
          const status = getStatusCode(lastDisconnect?.error);
          if (status === LOGGED_OUT_STATUS) {
            console.error(
              danger(
                `WhatsApp session logged out. Run: ${formatCliCommand("openclaw channels login")}`,
              ),
            );
          }
        }
        if (connection === "open" && verbose) {
          console.log(success("WhatsApp Web connected."));
        }
      } catch (err) {
        sessionLogger.error({ error: String(err) }, "connection.update handler error");
      }
    },
  );

  // Handle WebSocket-level errors to prevent unhandled exceptions from crashing the process
  if (sock.ws && typeof (sock.ws as unknown as { on?: unknown }).on === "function") {
    sock.ws.on("error", (err: Error) => {
      sessionLogger.error({ error: String(err) }, "WebSocket error");
    });
  }

  return sock;
}

async function resolveEnvProxyAgent(
  logger: ReturnType<typeof getChildLogger>,
): Promise<Agent | undefined> {
  return resolveAmbientNodeProxyAgent<Agent>({
    onError: (err) => {
      logger.warn(
        { error: String(err) },
        "Failed to initialize env proxy agent for WhatsApp WebSocket connection",
      );
    },
    onUsingProxy: () => {
      logger.info("Using ambient env proxy for WhatsApp WebSocket connection");
    },
  });
}

export async function waitForWaConnection(sock: ReturnType<typeof makeWASocket>) {
  return new Promise<void>((resolve, reject) => {
    type OffCapable = {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const evWithOff = sock.ev as unknown as OffCapable;

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<import("@whiskeysockets/baileys").ConnectionState>;
      if (update.connection === "open") {
        evWithOff.off?.("connection.update", handler);
        resolve();
      }
      if (update.connection === "close") {
        evWithOff.off?.("connection.update", handler);
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };

    sock.ev.on("connection.update", handler);
  });
}

/** Await pending credential saves — scoped to one authDir, or all if omitted. */
export function waitForCredsSaveQueue(authDir?: string): Promise<void> {
  if (authDir) {
    return credsSaveQueues.get(authDir) ?? Promise.resolve();
  }
  return Promise.all(credsSaveQueues.values()).then(() => {});
}

/** Await pending credential saves, but don't hang forever on stalled I/O. */
export async function waitForCredsSaveQueueWithTimeout(
  authDir: string,
  timeoutMs = CREDS_SAVE_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    waitForCredsSaveQueue(authDir),
    new Promise<void>((resolve) => {
      flushTimeout = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
    }
  });
}

export function newConnectionId() {
  return randomUUID();
}
