import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
  type ClawdbotConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/lanxin";
import { resolveLanxinAccount } from "./accounts.js";
import { logLanxinDebug } from "./debug.js";
import { decryptLanxinDataEncrypt } from "./decrypt.js";
import { handleLanxinInbound } from "./inbound.js";
import { createLanxinReplayGuard } from "./replay-guard.js";
import { getLanxinRuntime } from "./runtime.js";
import type { LanxinInboundEventEnvelope, LanxinInboundMessage } from "./types.js";

export type MonitorLanxinOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const DEFAULT_WEBHOOK_PORT = 8789;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/lanxin/callback";
const DEFAULT_WEBHOOK_BODY_LIMIT = 1024 * 1024;
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function resolveWebhookTimestampMs(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Lanxin deployments may provide timestamp in seconds or milliseconds.
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function validateWebhookSignatureParams(params: {
  timestamp: string;
  nonce: string;
  signature: string;
}): { ok: true } | { ok: false; message: string } {
  if (resolveWebhookTimestampMs(params.timestamp) == null) {
    return { ok: false, message: "Invalid timestamp" };
  }
  if (!params.nonce || params.nonce.length > 256) {
    return { ok: false, message: "Invalid nonce" };
  }
  if (!params.signature || params.signature.length > 512) {
    return { ok: false, message: "Invalid signature" };
  }
  return { ok: true };
}

function readLanxinMessageText(data: Record<string, unknown>, msgType: string): string {
  const msgData = data.msgData as Record<string, unknown> | undefined;
  const block = msgData?.[msgType] as Record<string, unknown> | undefined;
  const content = block?.content;
  return typeof content === "string" ? content : "";
}

function readLanxinMediaIds(data: Record<string, unknown>, msgType: string): string[] {
  const msgData = data.msgData as Record<string, unknown> | undefined;
  const block = msgData?.[msgType] as Record<string, unknown> | undefined;
  const mediaIds = block?.mediaIds;
  if (!Array.isArray(mediaIds)) return [];
  return mediaIds.map((v) => String(v).trim()).filter(Boolean);
}

function toInboundMessage(event: LanxinInboundEventEnvelope): LanxinInboundMessage | null {
  const type = String(event.type ?? "").trim();
  const data = event.data;
  if (!type || !data || typeof data !== "object") return null;
  const msgType = String(data.msgType ?? "text").trim() || "text";
  const entryId = String(data.entryId ?? "").trim();
  const messageId = String(data.msgId ?? "").trim() || `lanxin:${Date.now()}`;
  if (!entryId) return null;

  if (type === "bot_group_message") {
    const groupId = String(data.groupId ?? "").trim();
    const senderId = String(data.from ?? data.FromStaffId ?? "").trim();
    if (!groupId || !senderId) return null;
    return {
      messageId,
      timestamp: Date.now(),
      isGroup: true,
      senderId,
      userId: senderId,
      groupId,
      entryId,
      text: readLanxinMessageText(data, msgType),
      msgType,
      mediaIds: readLanxinMediaIds(data, msgType),
    };
  }

  if (type === "bot_private_message") {
    const userId = String(data.FromStaffId ?? data.from ?? "").trim();
    if (!userId) return null;
    return {
      messageId,
      timestamp: Date.now(),
      isGroup: false,
      senderId: userId,
      userId,
      entryId,
      text: readLanxinMessageText(data, msgType),
      msgType,
      mediaIds: readLanxinMediaIds(data, msgType),
    };
  }

  return null;
}

export async function monitorLanxinProvider(opts: MonitorLanxinOpts = {}): Promise<void> {
  const core = getLanxinRuntime();
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Lanxin monitor");
  }

  const log = opts.runtime?.log ?? console.log;
  const error = opts.runtime?.error ?? console.error;

  const account = resolveLanxinAccount({ cfg, accountId: opts.accountId });
  if (!account.enabled || !account.configured) {
    throw new Error(
      `Lanxin account "${opts.accountId ?? account.accountId}" not configured or disabled`,
    );
  }
  if (!account.aesKey) {
    throw new Error(
      `Lanxin account "${account.accountId}" missing aesKey (required to decrypt webhook payloads)`,
    );
  }
  const aesKey = account.aesKey;

  const port = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = account.config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const path = account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  const stateDir = core.state.resolveStateDir(process.env, os.homedir);
  const replayGuard = createLanxinReplayGuard({
    stateDir,
    onDiskError: (diskErr) => {
      error(`lanxin: replay dedupe disk error: ${String(diskErr)}`);
    },
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const reqPath = reqUrl.pathname;
    if (reqPath === "/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST" || reqPath !== path) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }
    const timestamp = reqUrl.searchParams.get("timestamp")?.trim() ?? "";
    const nonce = reqUrl.searchParams.get("nonce")?.trim() ?? "";
    const signature = reqUrl.searchParams.get("signature")?.trim() ?? "";
    if (!timestamp || !nonce || !signature) {
      error(
        `lanxin: webhook signature params missing: timestamp=${Boolean(timestamp)} nonce=${Boolean(nonce)} signature=${Boolean(signature)}`,
      );
      writeJson(res, 401, { error: "Missing signature query parameters" });
      return;
    }
    const signatureValidation = validateWebhookSignatureParams({
      timestamp,
      nonce,
      signature,
    });
    if (!signatureValidation.ok) {
      error(`lanxin: webhook signature validation failed: ${signatureValidation.message}`);
      writeJson(res, 401, { error: signatureValidation.message });
      return;
    }

    try {
      const body = await readRequestBodyWithLimit(req, {
        maxBytes: DEFAULT_WEBHOOK_BODY_LIMIT,
        timeoutMs: DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
      });
      const payload = JSON.parse(body) as { dataEncrypt?: string };
      const dataEncrypt =
        typeof payload?.dataEncrypt === "string" ? payload.dataEncrypt.trim() : "";
      if (!dataEncrypt) {
        writeJson(res, 400, { error: "Missing dataEncrypt" });
        return;
      }
      const decrypted = decryptLanxinDataEncrypt({
        dataEncrypt,
        aesKey,
      });
      const events = Array.isArray(decrypted.events) ? decrypted.events : [];
      logLanxinDebug(cfg, "webhook decrypted events", {
        count: events.length,
      });
      writeJson(res, 200, { ok: true });

      for (const event of events) {
        const eventId = String(event.id ?? "").trim();
        if (eventId) {
          const shouldProcess = await replayGuard.shouldProcessEvent({
            accountId: account.accountId,
            eventId,
          });
          if (!shouldProcess) {
            logLanxinDebug(cfg, "skip duplicated event", {
              eventId,
              type: event.type,
            });
            continue;
          }
        }
        const message = toInboundMessage(event);
        if (!message) continue;
        try {
          await handleLanxinInbound({
            message,
            account,
            config: cfg,
            runtime: opts.runtime ?? { log, error, exit: process.exit },
            statusSink: opts.statusSink,
          });
        } catch (err) {
          error(`lanxin: inbound handling failed: ${String(err)}`);
        }
      }
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        writeJson(res, 413, { error: "Payload too large" });
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        writeJson(res, 408, { error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") });
        return;
      }
      error(`lanxin: webhook request failed: ${String(err)}`);
      writeJson(res, 500, { error: "Internal server error" });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
  log(`lanxin: webhook server listening on http://${host}:${port}${path}`);

  opts.abortSignal?.addEventListener(
    "abort",
    () => {
      try {
        server.close();
      } catch {
        // ignore close races
      }
    },
    { once: true },
  );

  await new Promise<void>((resolve) => {
    opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    if (opts.abortSignal?.aborted) resolve();
  });

  try {
    server.close();
  } catch {
    // ignore
  }
}
