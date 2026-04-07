/**
 * Missed-Call-to-SMS — webhook server.
 *
 * Owns one HTTP server (node:http, no Express dep) that handles two
 * Telnyx webhook surfaces:
 *
 *   POST {basePath}/voice  → Telnyx Call Control events
 *   POST {basePath}/sms    → Telnyx Messaging events
 *
 * Voice flow:
 *   call.initiated   → answer the call, speak greeting, start recording
 *   call.recording.saved → fetch download URL, run Deepgram, attach
 *                          voicemail to convo, fire agent first turn
 *   call.hangup      → noop (recording.saved fires regardless)
 *
 * SMS flow:
 *   message.received → dispatch to AgentEngine.handleInboundSms
 *   message.sent / message.finalized → log delivery
 *
 * Signature verification uses Telnyx's Ed25519 public key per docs.
 * Disabled when config.skipSignatureVerification = true (dev only).
 */

import { verify as nacl_verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEngine } from "./agent.js";
import type { MissedCallSmsConfig } from "./config.js";
import { DeepgramClient } from "./deepgram.js";
import type { RuntimeLogger } from "./runtime.js";
import type { MissedCallSmsStore } from "./store.js";
import type { TelnyxCallsClient } from "./telnyx-calls.js";
import type { TelnyxMessagingClient } from "./telnyx-sms.js";

export interface WebhookServer {
  stop(): Promise<void>;
}

export interface StartWebhookOptions {
  config: MissedCallSmsConfig;
  store: MissedCallSmsStore;
  telnyxCalls: TelnyxCallsClient;
  telnyxSms: TelnyxMessagingClient;
  agent: AgentEngine;
  logger: RuntimeLogger;
}

interface TelnyxEnvelope {
  data?: {
    event_type?: string;
    payload?: Record<string, unknown>;
  };
}

export async function startWebhookServer(opts: StartWebhookOptions): Promise<WebhookServer> {
  const { config, store, telnyxCalls, telnyxSms, agent, logger } = opts;
  const deepgram = new DeepgramClient({
    apiKey: config.deepgram.apiKey!,
    model: config.deepgram.model,
    logger,
  });

  const basePath = config.webhook.path.replace(/\/$/, "");
  const voicePath = `${basePath}/voice`;
  const smsPath = `${basePath}/sms`;
  const healthPath = `${basePath}/health`;
  const apiPrefix = `${basePath}/api`;
  const uiPath = `${basePath}/ui`;

  // Resolve the static dashboard HTML location relative to this source file.
  // The runtime serves it from extensions/missed-call-sms/dashboard/index.html.
  const __filename = fileURLToPath(import.meta.url);
  const dashboardHtmlPath = join(dirname(__filename), "..", "dashboard", "index.html");

  const server: Server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      logger.error(
        `[missed-call-sms] webhook handler crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("internal error");
      }
    }
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === healthPath) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "missed-call-sms" }));
      return;
    }

    // Static dashboard UI — served from disk for v1 simplicity.
    if (method === "GET" && (url === uiPath || url === `${uiPath}/`)) {
      try {
        const html = await readFile(dashboardHtmlPath, "utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      } catch {
        res.statusCode = 404;
        res.end("dashboard html not found");
      }
      return;
    }

    // Mission Control dashboard API — JSON, gated by shared secret.
    if (url && url.startsWith(apiPrefix)) {
      await handleDashboardApi(req, res, url.slice(apiPrefix.length));
      return;
    }

    if (method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }

    if (url !== voicePath && url !== smsPath) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const rawBody = await readBody(req);

    if (!config.skipSignatureVerification && config.telnyx.publicKey) {
      const sig = req.headers["telnyx-signature-ed25519"];
      const ts = req.headers["telnyx-timestamp"];
      if (
        typeof sig !== "string" ||
        typeof ts !== "string" ||
        !verifyTelnyxSignature(config.telnyx.publicKey, sig, ts, rawBody)
      ) {
        logger.warn("[missed-call-sms] webhook signature verification failed");
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
    }

    let envelope: TelnyxEnvelope;
    try {
      envelope = JSON.parse(rawBody) as TelnyxEnvelope;
    } catch {
      res.statusCode = 400;
      res.end("bad json");
      return;
    }

    // Always 200 fast — Telnyx retries aggressively on non-2xx, and the
    // actual work happens async after we ack.
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));

    const eventType = envelope.data?.event_type;
    const payload = envelope.data?.payload ?? {};
    if (!eventType) return;

    if (url === voicePath) {
      await handleVoiceEvent(eventType, payload).catch((err) =>
        logger.error(
          `[missed-call-sms] voice handler error: ${err instanceof Error ? err.message : err}`,
        ),
      );
    } else if (url === smsPath) {
      await handleSmsEvent(eventType, payload).catch((err) =>
        logger.error(
          `[missed-call-sms] sms handler error: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
  }

  async function handleDashboardApi(
    req: IncomingMessage,
    res: ServerResponse,
    subPath: string,
  ): Promise<void> {
    // Auth: shared secret. If unset, allow loopback only (dev safeguard).
    if (config.dashboardToken) {
      const provided = req.headers["x-mcs-token"];
      if (provided !== config.dashboardToken) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
    } else {
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote.endsWith("127.0.0.1");
      if (!isLoopback) {
        res.statusCode = 401;
        res.end("dashboardToken not configured; remote access denied");
        return;
      }
    }

    res.setHeader("content-type", "application/json");
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    const method = req.method ?? "GET";
    // Strip query string for routing.
    const path = subPath.split("?")[0] ?? "";
    const queryString = subPath.includes("?") ? subPath.slice(subPath.indexOf("?") + 1) : "";
    const query = new URLSearchParams(queryString);

    try {
      // GET /conversations?status=open&limit=50
      if (method === "GET" && path === "/conversations") {
        const status = query.get("status") ?? "open";
        const limit = Number(query.get("limit") ?? "50");
        const items = await store.listConversations({ status, limit });
        return json(200, { items });
      }

      // GET /conversations/:id
      const getMatch = path.match(/^\/conversations\/([^/]+)$/);
      if (method === "GET" && getMatch) {
        const convo = await store.getConversation(getMatch[1]!);
        if (!convo) return json(404, { error: "not found" });
        return json(200, { conversation: convo });
      }

      // POST /conversations/:id/reply  { message }
      const replyMatch = path.match(/^\/conversations\/([^/]+)\/reply$/);
      if (method === "POST" && replyMatch) {
        const body = await readBody(req);
        const parsed = body ? (JSON.parse(body) as { message?: string }) : {};
        const message = (parsed.message ?? "").trim();
        if (!message) return json(400, { error: "message required" });

        const convo = await store.getConversation(replyMatch[1]!);
        if (!convo) return json(404, { error: "not found" });

        try {
          const result = await telnyxSms.send({
            to: convo.callerPhone,
            text: message,
          });
          await store.appendMessage(convo.id, {
            role: "human-owner",
            content: message,
            providerMessageId: result.messageId,
          });
          return json(200, { success: true, messageId: result.messageId });
        } catch (err) {
          return json(500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // POST /conversations/:id/takeover
      const takeoverMatch = path.match(/^\/conversations\/([^/]+)\/takeover$/);
      if (method === "POST" && takeoverMatch) {
        await store.setStatus(takeoverMatch[1]!, "human-takeover");
        return json(200, { success: true });
      }

      // POST /conversations/:id/close
      const closeMatch = path.match(/^\/conversations\/([^/]+)\/close$/);
      if (method === "POST" && closeMatch) {
        await store.setStatus(closeMatch[1]!, "closed");
        return json(200, { success: true });
      }

      return json(404, { error: "no such API route" });
    } catch (err) {
      logger.error(
        `[missed-call-sms] dashboard api crashed: ${err instanceof Error ? err.message : err}`,
      );
      return json(500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleVoiceEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const callControlId = String(payload.call_control_id ?? "");
    const fromRaw = String(payload.from ?? "");
    const toRaw = String(payload.to ?? "");
    // Telnyx phone numbers are E.164 in the payload already.
    const callerPhone = normalizeE164(fromRaw);
    const businessPhone = normalizeE164(toRaw);

    logger.info(
      `[missed-call-sms] voice event ${eventType} ccid=${callControlId} from=${callerPhone} to=${businessPhone}`,
    );

    switch (eventType) {
      case "call.initiated": {
        if (!callControlId || !callerPhone) return;
        // Open / reuse a conversation for this caller right away so the
        // recording flow has a target. The voicemail is attached when
        // call.recording.saved fires.
        const convo = await store.getOrCreate(callerPhone, businessPhone);
        // Persist the call_control_id for debugging cross-references.
        // (We do this via setStatus → updates updatedAt; the call id is
        // logged here for traceability.)
        try {
          await telnyxCalls.answer(callControlId);
        } catch (err) {
          logger.error(
            `[missed-call-sms] failed to answer call: ${err instanceof Error ? err.message : err}`,
          );
          return;
        }

        // Speak the greeting via Telnyx native TTS, then start recording.
        // Per memory: don't send commands during transfer (n/a here);
        // call.answered webhook is unreliable so we just chain calls.
        try {
          await telnyxCalls.speak(callControlId, config.business.greeting);
        } catch (err) {
          logger.warn(
            `[missed-call-sms] speak greeting failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        try {
          await telnyxCalls.startRecording(callControlId, {
            maxLengthSecs: config.voicemail.maxRecordSeconds,
            playBeep: true,
          });
        } catch (err) {
          logger.error(
            `[missed-call-sms] startRecording failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        return;
      }

      case "call.recording.saved": {
        // Telnyx delivers recording_id + (sometimes) public_recording_urls.
        const recordingId = String(payload.recording_id ?? "");
        const inlineUrls = payload.public_recording_urls as { mp3?: string } | undefined;
        let recordingUrl = inlineUrls?.mp3;
        if (!recordingUrl && recordingId) {
          recordingUrl = await telnyxCalls.getRecordingUrl(recordingId);
        }
        if (!recordingUrl) {
          logger.warn(`[missed-call-sms] recording.saved with no URL for ccid=${callControlId}`);
          return;
        }

        const convo = await store.getActiveByPhone(callerPhone);
        if (!convo) {
          logger.warn(
            `[missed-call-sms] no active conversation for ${callerPhone} on recording.saved`,
          );
          return;
        }

        // Transcribe via Deepgram.
        let transcript = "";
        let confidence = 0;
        try {
          const result = await deepgram.transcribeFromUrl(recordingUrl);
          transcript = result.transcript;
          confidence = result.confidence;
        } catch (err) {
          logger.error(
            `[missed-call-sms] deepgram transcription failed: ${err instanceof Error ? err.message : err}`,
          );
        }

        await store.attachVoicemail(convo.id, {
          recordingUrl,
          transcript,
          transcriptConfidence: confidence,
          durationSeconds:
            typeof payload.recording_duration_millis === "number"
              ? Math.round(payload.recording_duration_millis / 1000)
              : undefined,
          capturedAt: new Date().toISOString(),
        });

        // Fire the agent's first turn (sends initial SMS to the caller).
        const turn = await agent.handleVoicemail(convo.id);
        if (!turn.success) {
          logger.error(`[missed-call-sms] first agent turn failed: ${turn.error}`);
        }
        return;
      }

      case "call.hangup":
      case "call.recording.error":
        // Nothing to do — recording.saved is the trigger we care about.
        return;

      default:
        // Unhandled event type — log at debug level only to avoid noise.
        logger.debug?.(`[missed-call-sms] ignoring voice event ${eventType}`);
        return;
    }
  }

  async function handleSmsEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (eventType !== "message.received") {
      // message.sent / message.finalized / message.failed — log only.
      if (eventType === "message.failed") {
        logger.warn(
          `[missed-call-sms] outbound SMS failed: ${JSON.stringify(payload).slice(0, 300)}`,
        );
      }
      return;
    }

    const fromObj = payload.from as { phone_number?: string } | undefined;
    const callerPhone = normalizeE164(fromObj?.phone_number ?? "");
    const text = String(payload.text ?? "").trim();
    const providerMessageId = String(payload.id ?? "");

    if (!callerPhone || !text) {
      logger.warn("[missed-call-sms] inbound SMS missing from/text");
      return;
    }

    logger.info(`[missed-call-sms] inbound SMS from=${callerPhone} text="${text.slice(0, 80)}"`);

    const result = await agent.handleInboundSms(callerPhone, text, providerMessageId);
    if (!result.success) {
      logger.error(`[missed-call-sms] inbound SMS handler failed: ${result.error}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.webhook.port, config.webhook.bind, () => {
      server.off("error", reject);
      logger.info(
        `[missed-call-sms] webhook listening on http://${config.webhook.bind}:${config.webhook.port}${basePath} (voice=${voicePath} sms=${smsPath})`,
      );
      resolve();
    });
  });

  return {
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------- helpers ----------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  // Telnyx sometimes omits the leading +; add it.
  if (/^\d+$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

/**
 * Verify a Telnyx Ed25519 webhook signature.
 *
 * Telnyx signs `${timestamp}|${rawBody}` with their Ed25519 private key
 * and provides a base64-encoded signature in `Telnyx-Signature-Ed25519`.
 * The public key (also base64) lives in the Telnyx portal under the
 * Call Control / Messaging Profile settings.
 */
function verifyTelnyxSignature(
  publicKeyBase64: string,
  signatureBase64: string,
  timestamp: string,
  rawBody: string,
): boolean {
  try {
    const message = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
    const signature = Buffer.from(signatureBase64, "base64");
    // Ed25519 raw public key (32 bytes) → SPKI DER prefix for crypto.verify
    const rawKey = Buffer.from(publicKeyBase64, "base64");
    if (rawKey.length !== 32) return false;
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiKey = Buffer.concat([spkiPrefix, rawKey]);
    return nacl_verify(
      null,
      message,
      {
        key: spkiKey,
        format: "der",
        type: "spki",
      },
      signature,
    );
  } catch {
    return false;
  }
}
