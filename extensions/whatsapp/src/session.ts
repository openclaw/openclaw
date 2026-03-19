import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger, toPinoLikeLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import qrcode from "qrcode-terminal";
import { EnvHttpProxyAgent } from "undici";
import { resolveEnvHttpProxyUrl } from "../../../src/infra/net/proxy-env.js";
import { resolveProxyFetchFromEnv } from "../../../src/infra/net/proxy-fetch.js";
import {
  maybeRestoreCredsFromBackup,
  readCredsJsonRaw,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
} from "./auth-store.js";

export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  readWebSelfId,
  WA_WEB_AUTH_DIR,
  webAuthExists,
} from "./auth-store.js";

// Per-authDir queues so multi-account creds saves don't block each other.
const credsSaveQueues = new Map<string, Promise<void>>();
const CREDS_SAVE_FLUSH_TIMEOUT_MS = 15_000;
const WHATSAPP_WEB_SW_URL = "https://web.whatsapp.com/sw.js";
const WHATSAPP_WEB_SW_MAX_BYTES = 512 * 1024;
const WHATSAPP_WEB_VERSION_HEADERS = {
  "sec-fetch-site": "none",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
} as const;
const WHATSAPP_WEB_SOCKET_HOST = "web.whatsapp.com";

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
      if (credsSaveQueues.get(authDir) === next) credsSaveQueues.delete(authDir);
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
      fsSync.chmodSync(resolveWebCredsPath(authDir), 0o600);
    } catch {
      // best-effort on platforms that support it
    }
  } catch (err) {
    logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
  }
}

function extractWhatsAppWebVersion(source: string): [number, number, number] | null {
  const match = source.match(/client_revision[^0-9]*(\d+)/);
  if (!match) {
    return null;
  }
  const revision = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(revision) || revision <= 0) {
    return null;
  }
  return [2, 3000, revision];
}

function parseNoProxyRules(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.no_proxy ?? env.NO_PROXY;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function stripNoProxyPort(rule: string): string {
  if (rule.startsWith("[") && rule.includes("]")) {
    const end = rule.indexOf("]");
    return end >= 0 ? rule.slice(0, end + 1) : rule;
  }
  const colonIndex = rule.lastIndexOf(":");
  if (colonIndex <= 0 || rule.includes(".")) {
    return colonIndex > 0 ? rule.slice(0, colonIndex) : rule;
  }
  return rule;
}

function shouldBypassEnvProxyForHostname(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalizedHost = hostname.trim().toLowerCase();
  if (!normalizedHost) {
    return false;
  }
  return parseNoProxyRules(env).some((rawRule) => {
    if (rawRule === "*") {
      return true;
    }
    const rule = stripNoProxyPort(rawRule).replace(/^\*\./, ".").toLowerCase();
    if (!rule) {
      return false;
    }
    if (rule.startsWith(".")) {
      const bareRule = rule.slice(1);
      return normalizedHost === bareRule || normalizedHost.endsWith(rule);
    }
    return normalizedHost === rule || normalizedHost.endsWith(`.${rule}`);
  });
}

async function readResponseTextCapped(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return null;
    }
  }
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("WhatsApp sw.js response too large");
        } catch {
          // ignore reader cancellation errors
        }
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchLatestWhatsAppWebVersion(
  fetchImpl: typeof fetch,
): Promise<[number, number, number] | null> {
  try {
    const response = await fetchImpl(WHATSAPP_WEB_SW_URL, {
      method: "GET",
      headers: WHATSAPP_WEB_VERSION_HEADERS,
    });
    if (!response.ok) {
      return null;
    }
    const source = await readResponseTextCapped(response, WHATSAPP_WEB_SW_MAX_BYTES);
    if (!source) {
      return null;
    }
    return extractWhatsAppWebVersion(source);
  } catch {
    return null;
  }
}

async function resolveWhatsAppWebVersion(
  sessionLogger: ReturnType<typeof getChildLogger>,
): Promise<[number, number, number]> {
  const latest = await fetchLatestBaileysVersion();
  if (latest.isLatest) {
    return latest.version;
  }

  const fetchImpl = resolveProxyFetchFromEnv() ?? globalThis.fetch;
  const proxyVersion = fetchImpl ? await fetchLatestWhatsAppWebVersion(fetchImpl) : null;
  if (!proxyVersion) {
    return latest.version;
  }

  sessionLogger.info(
    {
      version: proxyVersion,
    },
    "using proxy-refreshed WhatsApp Web version",
  );
  return proxyVersion;
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
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await resolveWhatsAppWebVersion(sessionLogger);
  const proxyUrl = resolveEnvHttpProxyUrl("https");
  const wsAgent =
    proxyUrl && !shouldBypassEnvProxyForHostname(WHATSAPP_WEB_SOCKET_HOST)
      ? new HttpsProxyAgent(proxyUrl)
      : undefined;
  const fetchAgent = proxyUrl ? new EnvHttpProxyAgent() : undefined;
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
    ...(wsAgent ? { agent: wsAgent } : {}),
    ...(fetchAgent ? { fetchAgent } : {}),
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
          if (status === DisconnectReason.loggedOut) {
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

export function getStatusCode(err: unknown) {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status ??
    (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode
  );
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

function safeStringify(value: unknown, limit = 800): string {
  try {
    const seen = new WeakSet();
    const raw = JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "bigint") {
          return v.toString();
        }
        if (typeof v === "function") {
          const maybeName = (v as { name?: unknown }).name;
          const name =
            typeof maybeName === "string" && maybeName.length > 0 ? maybeName : "anonymous";
          return `[Function ${name}]`;
        }
        if (typeof v === "object" && v) {
          if (seen.has(v)) {
            return "[Circular]";
          }
          seen.add(v);
        }
        return v;
      },
      2,
    );
    if (!raw) {
      return String(value);
    }
    return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
  } catch {
    return String(value);
  }
}

function extractBoomDetails(err: unknown): {
  statusCode?: number;
  error?: string;
  message?: string;
} | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const output = (err as { output?: unknown })?.output as
    | { statusCode?: unknown; payload?: unknown }
    | undefined;
  if (!output || typeof output !== "object") {
    return null;
  }
  const payload = (output as { payload?: unknown }).payload as
    | { error?: unknown; message?: unknown; statusCode?: unknown }
    | undefined;
  const statusCode =
    typeof (output as { statusCode?: unknown }).statusCode === "number"
      ? ((output as { statusCode?: unknown }).statusCode as number)
      : typeof payload?.statusCode === "number"
        ? payload.statusCode
        : undefined;
  const error = typeof payload?.error === "string" ? payload.error : undefined;
  const message = typeof payload?.message === "string" ? payload.message : undefined;
  if (!statusCode && !error && !message) {
    return null;
  }
  return { statusCode, error, message };
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (!err || typeof err !== "object") {
    return String(err);
  }

  // Baileys frequently wraps errors under `error` with a Boom-like shape.
  const boom =
    extractBoomDetails(err) ??
    extractBoomDetails((err as { error?: unknown })?.error) ??
    extractBoomDetails((err as { lastDisconnect?: { error?: unknown } })?.lastDisconnect?.error);

  const status = boom?.statusCode ?? getStatusCode(err);
  const code = (err as { code?: unknown })?.code;
  const codeText = typeof code === "string" || typeof code === "number" ? String(code) : undefined;

  const messageCandidates = [
    boom?.message,
    typeof (err as { message?: unknown })?.message === "string"
      ? ((err as { message?: unknown }).message as string)
      : undefined,
    typeof (err as { error?: { message?: unknown } })?.error?.message === "string"
      ? ((err as { error?: { message?: unknown } }).error?.message as string)
      : undefined,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));
  const message = messageCandidates[0];

  const pieces: string[] = [];
  if (typeof status === "number") {
    pieces.push(`status=${status}`);
  }
  if (boom?.error) {
    pieces.push(boom.error);
  }
  if (message) {
    pieces.push(message);
  }
  if (codeText) {
    pieces.push(`code=${codeText}`);
  }

  if (pieces.length > 0) {
    return pieces.join(" ");
  }
  return safeStringify(err);
}

export function newConnectionId() {
  return randomUUID();
}
