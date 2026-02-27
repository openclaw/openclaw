import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

type PluginConfig = {
  supabaseUrl: string;
  supabaseServiceKey: string;
  supabaseAnonKey?: string;
  storageBucket?: string;
};

type ElevenLabsCfg = {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  languageCode?: string;
  baseUrl?: string;
};

function supabaseHeaders(config: PluginConfig) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.supabaseServiceKey}`,
    apikey: config.supabaseServiceKey,
  };
}

async function supabaseInsert(config: PluginConfig, row: Record<string, unknown>): Promise<void> {
  const url = `${config.supabaseUrl}/rest/v1/chat_messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supabaseHeaders(config), Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase insert error ${res.status}: ${body}`);
  }
}

async function supabaseUpdateTranscriptionByMessageId(
  config: PluginConfig,
  messageId: string,
  transcript: string,
): Promise<boolean> {
  const url = `${config.supabaseUrl}/rest/v1/chat_messages?message_id=eq.${encodeURIComponent(messageId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders(config), Prefer: "return=representation" },
    body: JSON.stringify({ transcription: transcript, body: transcript }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase patch error ${res.status}: ${body}`);
  }
  const updated = (await res.json()) as unknown[];
  return updated.length > 0;
}

async function supabaseUpdateTranscriptionByFallback(
  config: PluginConfig,
  sender: string,
  conversationId: string,
  transcript: string,
): Promise<boolean> {
  const searchUrl =
    `${config.supabaseUrl}/rest/v1/chat_messages` +
    `?sender=eq.${encodeURIComponent(sender)}` +
    `&chat_id=eq.${encodeURIComponent(conversationId)}` +
    `&direction=eq.inbound` +
    `&transcription=is.null` +
    `&or=(media_type.ilike.*audio*,body.eq.%3Cmedia%3Aaudio%3E)` +
    `&order=timestamp.desc` +
    `&limit=1` +
    `&select=id`;

  const findRes = await fetch(searchUrl, {
    method: "GET",
    headers: supabaseHeaders(config),
  });
  if (!findRes.ok) {
    const body = await findRes.text().catch(() => "");
    throw new Error(`Supabase search error ${findRes.status}: ${body}`);
  }
  const rows = (await findRes.json()) as Array<{ id: string }>;
  if (rows.length === 0) return false;

  const updateUrl = `${config.supabaseUrl}/rest/v1/chat_messages?id=eq.${rows[0].id}`;
  const patchRes = await fetch(updateUrl, {
    method: "PATCH",
    headers: { ...supabaseHeaders(config), Prefer: "return=minimal" },
    body: JSON.stringify({ transcription: transcript, body: transcript }),
  });
  if (!patchRes.ok) {
    const body = await patchRes.text().catch(() => "");
    throw new Error(`Supabase fallback patch error ${patchRes.status}: ${body}`);
  }
  return true;
}

// ── Phase 3 helpers ──

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function supabaseStorageUpload(
  config: PluginConfig,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const bucket = config.storageBucket ?? "iris-media";

  // 1. Upload the file
  const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${bucket}/${path}`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      "Content-Type": contentType,
    },
    body: buffer as unknown as BodyInit,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => "");
    throw new Error(`Supabase Storage upload error ${uploadRes.status}: ${body}`);
  }

  // 2. Generate a signed URL valid for 5 minutes (enough for WhatsApp/Telegram to download)
  const signUrl = `${config.supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`;
  const signRes = await fetch(signUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!signRes.ok) {
    const body = await signRes.text().catch(() => "");
    throw new Error(`Supabase Storage sign error ${signRes.status}: ${body}`);
  }
  const { signedURL } = (await signRes.json()) as { signedURL: string };
  // signedURL is relative to /storage/v1 (e.g. "/object/sign/bucket/path?token=...")
  // but some Supabase versions already include /storage/v1 — handle both
  const base = signedURL.startsWith("/storage/v1")
    ? config.supabaseUrl
    : `${config.supabaseUrl}/storage/v1`;
  return `${base}${signedURL}`;
}

async function ttsElevenLabs(text: string, cfg: ElevenLabsCfg): Promise<Buffer> {
  const base = (cfg.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
  const url = `${base}/v1/text-to-speech/${cfg.voiceId}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": cfg.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: cfg.modelId ?? "eleven_multilingual_v2",
      language_code: cfg.languageCode ?? "pt",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS error ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function sendViaChannel(
  api: OpenClawPluginApi,
  channel: string | null | undefined,
  to: string,
  opts: { text?: string; mediaUrl?: string; contentType?: string; accountId?: string },
): Promise<void> {
  const ch = (channel ?? "whatsapp").toLowerCase();
  const isAudio =
    !!opts.contentType?.startsWith("audio/") ||
    !!opts.mediaUrl?.match(/\.(mp3|ogg|opus|m4a|webm|wav)(\?|$)/i);

  if (ch === "telegram") {
    await (
      api.runtime.channel as unknown as Record<
        string,
        Record<string, (...args: unknown[]) => Promise<unknown>>
      >
    ).telegram.sendMessageTelegram(to, opts.text ?? "", {
      mediaUrl: opts.mediaUrl,
      asVoice: isAudio,
      accountId: opts.accountId,
    });
  } else {
    await (
      api.runtime.channel as unknown as Record<
        string,
        Record<string, (...args: unknown[]) => Promise<unknown>>
      >
    ).whatsapp.sendMessageWhatsApp(to, opts.text ?? "", {
      mediaUrl: opts.mediaUrl,
      accountId: opts.accountId,
    });
  }
}

function mediaTypeFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

async function insertOutboundRow(
  config: PluginConfig,
  opts: {
    chatId: string;
    channel: string;
    accountId?: string | null;
    body?: string | null;
    mediaUrl?: string | null;
    contentType?: string | null;
  },
): Promise<void> {
  const row = {
    sender: opts.accountId ?? "iris",
    sender_name: null,
    chat_id: opts.chatId,
    direction: "outbound",
    body: opts.body ?? null,
    media_url: opts.mediaUrl ?? null,
    media_type: mediaTypeFromContentType(opts.contentType ?? undefined),
    channel: opts.channel,
    session_key: opts.accountId ?? null,
    timestamp: new Date().toISOString(),
    is_read: true,
    replied: true,
  };
  await supabaseInsert(config, row);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(payload);
}

function toIso(ts: number | undefined): string {
  return ts ? new Date(ts).toISOString() : new Date().toISOString();
}

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as PluginConfig | undefined;

  if (!config?.supabaseUrl || !config?.supabaseServiceKey) {
    console.warn(
      "[chat-history-supabase] Missing supabaseUrl or supabaseServiceKey — plugin disabled.",
    );
    return;
  }

  const log = (msg: string) => console.log(`[chat-history-supabase] ${msg}`);
  const logError = (msg: string, err: unknown) =>
    console.error(`[chat-history-supabase] ${msg}`, err);

  // -- Hook: inbound messages --
  api.on("message_received", async (event, ctx) => {
    const row = {
      sender: event.from,
      sender_name:
        (event.metadata?.pushName as string | undefined) ??
        (event.metadata?.senderName as string | undefined) ??
        null,
      chat_id: ctx.conversationId ?? ctx.channelId,
      direction: "inbound",
      body: event.content,
      channel: ctx.channelId,
      session_key: ctx.accountId ?? null,
      message_id:
        (event.metadata?.messageId as string | undefined) ??
        (event.metadata?.id as string | undefined) ??
        null,
      media_url: (event.metadata?.mediaUrl as string | undefined) ?? null,
      media_type: (event.metadata?.mediaType as string | undefined) ?? null,
      timestamp: toIso(event.timestamp),
      is_read: false,
      replied: false,
    };
    log(`INSERT inbound from=${event.from} chat=${row.chat_id} mid=${row.message_id}`);
    await supabaseInsert(config, row).catch((err: unknown) => {
      logError("Failed to insert received message:", err);
    });
  });

  // -- Hook: outbound messages --
  api.on("message_sent", async (event, ctx) => {
    if (!event.success) return;
    const row = {
      sender: ctx.accountId ?? "iris",
      sender_name: null,
      chat_id: ctx.conversationId ?? event.to,
      direction: "outbound",
      body: event.content,
      channel: ctx.channelId,
      session_key: ctx.accountId ?? null,
      message_id:
        (event.metadata?.messageId as string | undefined) ??
        (event.metadata?.id as string | undefined) ??
        null,
      media_url: (event.metadata?.mediaUrl as string | undefined) ?? null,
      media_type: (event.metadata?.mediaType as string | undefined) ?? null,
      timestamp: new Date().toISOString(),
      is_read: true,
      replied: true,
    };
    log(`INSERT outbound to=${event.to} chat=${row.chat_id} mid=${row.message_id}`);
    await supabaseInsert(config, row).catch((err: unknown) => {
      logError("Failed to insert sent message:", err);
    });
  });

  // -- Hook: audio transcriptions --
  // The upstream message_transcribed hook does NOT include messageId in metadata.
  // Strategy: try messageId first, then fall back to matching most recent
  // un-transcribed audio message from the same sender in the same conversation.
  try {
    api.on("message_transcribed", async (event, ctx) => {
      if (!event.transcript) return;

      const messageId =
        (event.metadata?.messageId as string | undefined) ??
        (event.metadata?.id as string | undefined);

      log(
        `TRANSCRIPTION from=${event.from} mid=${messageId ?? "none"} conv=${ctx.conversationId ?? "?"}`,
      );

      // Strategy 1: match by messageId (works if core includes it in metadata)
      if (messageId) {
        const updated = await supabaseUpdateTranscriptionByMessageId(
          config,
          messageId,
          event.transcript,
        ).catch((err: unknown) => {
          logError("Failed to update transcription by messageId:", err);
          return false;
        });
        if (updated) {
          log(`Transcription updated via messageId=${messageId}`);
          return;
        }
      }

      // Strategy 2: fallback -- find most recent audio msg without transcription
      const conversationId = ctx.conversationId ?? ctx.channelId;
      const sender = event.from;
      if (!sender || !conversationId) {
        logError("Cannot match transcription: missing sender or conversationId", {
          sender,
          conversationId,
        });
        return;
      }

      const updated = await supabaseUpdateTranscriptionByFallback(
        config,
        sender,
        conversationId,
        event.transcript,
      ).catch((err: unknown) => {
        logError("Failed to update transcription by fallback:", err);
        return false;
      });
      if (updated) {
        log(`Transcription updated via fallback (sender=${sender}, conv=${conversationId})`);
      } else {
        log(`No matching audio message found for transcription (sender=${sender})`);
      }
    });
  } catch {
    // Hook not available in this version of openclaw -- skip silently
  }

  // -- Serve the conversations monitoring UI --
  const htmlTemplate = readFileSync(join(__dirname, "ui/index.html"), "utf-8");
  const clientConfig = JSON.stringify({
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseAnonKey ?? config.supabaseServiceKey,
  });

  api.registerHttpRoute({
    path: "/conversations",
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      const html = htmlTemplate.replace(
        "<!-- __CONVERSATIONS_CONFIG__ -->",
        `<script>window.__CONVERSATIONS_CONFIG__ = ${clientConfig};</script>`,
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(html);
    },
  });

  // ── POST /conversations/send — envio de texto ──
  api.registerHttpRoute({
    path: "/conversations/send",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        jsonResponse(res, 405, { ok: false, error: "Method Not Allowed" });
        return;
      }
      try {
        const body = await readBody(req);
        const data = JSON.parse(body.toString("utf-8")) as {
          chatId?: string;
          channel?: string;
          accountId?: string;
          message?: string;
        };
        if (!data.chatId || !data.message) {
          jsonResponse(res, 400, { ok: false, error: "chatId and message are required" });
          return;
        }
        log(`SEND text to=${data.chatId} channel=${data.channel ?? "whatsapp"}`);
        await sendViaChannel(api, data.channel, data.chatId, {
          text: data.message,
          accountId: data.accountId,
        });
        insertOutboundRow(config, {
          chatId: data.chatId,
          channel: data.channel ?? "whatsapp",
          accountId: data.accountId,
          body: data.message,
        }).catch((err: unknown) => logError("Failed to insert outbound text row:", err));
        jsonResponse(res, 200, { ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("POST /conversations/send failed:", err);
        jsonResponse(res, 500, { ok: false, error: msg });
      }
    },
  });

  // ── POST /conversations/send-tts — texto → áudio ElevenLabs ──
  api.registerHttpRoute({
    path: "/conversations/send-tts",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        jsonResponse(res, 405, { ok: false, error: "Method Not Allowed" });
        return;
      }
      try {
        const body = await readBody(req);
        const data = JSON.parse(body.toString("utf-8")) as {
          chatId?: string;
          channel?: string;
          accountId?: string;
          text?: string;
        };
        if (!data.chatId || !data.text) {
          jsonResponse(res, 400, { ok: false, error: "chatId and text are required" });
          return;
        }

        const fullCfg = api.runtime.config.loadConfig() as Record<string, unknown>;
        const messages = fullCfg.messages as Record<string, unknown> | undefined;
        const tts = messages?.tts as Record<string, unknown> | undefined;
        const elCfg = tts?.elevenlabs as ElevenLabsCfg | undefined;

        if (!elCfg?.apiKey || !elCfg?.voiceId) {
          jsonResponse(res, 500, {
            ok: false,
            error: "ElevenLabs not configured. Set messages.tts.elevenlabs in openclaw.json.",
          });
          return;
        }

        log(
          `SEND TTS to=${data.chatId} channel=${data.channel ?? "whatsapp"} chars=${data.text.length}`,
        );
        const audioBuffer = await ttsElevenLabs(data.text, elCfg);
        const path = `tts/${Date.now()}.mp3`;
        const url = await supabaseStorageUpload(config, path, audioBuffer, "audio/mpeg");
        await sendViaChannel(api, data.channel, data.chatId, {
          mediaUrl: url,
          contentType: "audio/mpeg",
          accountId: data.accountId,
        });
        insertOutboundRow(config, {
          chatId: data.chatId,
          channel: data.channel ?? "whatsapp",
          accountId: data.accountId,
          body: data.text,
          mediaUrl: url,
          contentType: "audio/mpeg",
        }).catch((err: unknown) => logError("Failed to insert outbound TTS row:", err));
        jsonResponse(res, 200, { ok: true, url });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("POST /conversations/send-tts failed:", err);
        jsonResponse(res, 500, { ok: false, error: msg });
      }
    },
  });

  // ── POST /conversations/send-media — arquivo bruto ──
  // Query params: chatId, channel, accountId, contentType, filename, caption
  api.registerHttpRoute({
    path: "/conversations/send-media",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        jsonResponse(res, 405, { ok: false, error: "Method Not Allowed" });
        return;
      }
      try {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        const chatId = reqUrl.searchParams.get("chatId");
        const channel = reqUrl.searchParams.get("channel") ?? "whatsapp";
        const accountId = reqUrl.searchParams.get("accountId") ?? undefined;
        const contentType =
          reqUrl.searchParams.get("contentType") ??
          (req.headers["content-type"] as string | undefined) ??
          "application/octet-stream";
        const filename = reqUrl.searchParams.get("filename") ?? `file-${Date.now()}`;
        const caption = reqUrl.searchParams.get("caption") ?? undefined;

        if (!chatId) {
          jsonResponse(res, 400, { ok: false, error: "chatId query param is required" });
          return;
        }

        const buffer = await readBody(req);
        if (buffer.length === 0) {
          jsonResponse(res, 400, { ok: false, error: "Empty body" });
          return;
        }

        // Sanitize filename to avoid path traversal
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
        const path = `uploads/${Date.now()}-${safeName}`;
        log(`SEND media to=${chatId} channel=${channel} type=${contentType} size=${buffer.length}`);
        const url = await supabaseStorageUpload(config, path, buffer, contentType);
        await sendViaChannel(api, channel, chatId, {
          text: caption,
          mediaUrl: url,
          contentType,
          accountId,
        });
        insertOutboundRow(config, {
          chatId,
          channel,
          accountId,
          body: caption ?? null,
          mediaUrl: url,
          contentType,
        }).catch((err: unknown) => logError("Failed to insert outbound media row:", err));
        jsonResponse(res, 200, { ok: true, url });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("POST /conversations/send-media failed:", err);
        jsonResponse(res, 500, { ok: false, error: msg });
      }
    },
  });
}
