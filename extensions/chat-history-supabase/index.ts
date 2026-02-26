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
}
