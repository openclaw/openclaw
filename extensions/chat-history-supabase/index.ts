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

async function supabaseInsert(config: PluginConfig, row: Record<string, unknown>): Promise<void> {
  const url = `${config.supabaseUrl}/rest/v1/chat_messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase insert error ${res.status}: ${body}`);
  }
}

async function supabaseUpdateTranscription(
  config: PluginConfig,
  messageId: string,
  transcript: string,
): Promise<void> {
  const url = `${config.supabaseUrl}/rest/v1/chat_messages?message_id=eq.${encodeURIComponent(messageId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
    },
    body: JSON.stringify({ transcription: transcript }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase patch error ${res.status}: ${body}`);
  }
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

  // — Hook: inbound messages —
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
    await supabaseInsert(config, row).catch((err: unknown) => {
      console.error("[chat-history-supabase] Failed to insert received message:", err);
    });
  });

  // — Hook: outbound messages —
  api.on("message_sent", async (event, ctx) => {
    if (!event.success) return;
    const row = {
      sender: ctx.accountId ?? "iris",
      sender_name: null,
      chat_id: ctx.conversationId ?? ctx.channelId,
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
    await supabaseInsert(config, row).catch((err: unknown) => {
      console.error("[chat-history-supabase] Failed to insert sent message:", err);
    });
  });

  // — Hook: audio transcriptions (Iris-specific, not in upstream openclaw) —
  try {
    api.on("message_transcribed", async (event, _ctx) => {
      const messageId =
        (event.metadata?.messageId as string | undefined) ??
        (event.metadata?.id as string | undefined);
      if (!messageId || !event.transcript) return;
      await supabaseUpdateTranscription(config, messageId, event.transcript).catch(
        (err: unknown) => {
          console.error("[chat-history-supabase] Failed to update transcription:", err);
        },
      );
    });
  } catch {
    // Hook not available in this version of openclaw — skip silently
  }

  // — Serve the conversations monitoring UI —
  const htmlTemplate = readFileSync(join(__dirname, "ui/index.html"), "utf-8");
  const clientConfig = JSON.stringify({
    supabaseUrl: config.supabaseUrl,
    // Use anon key for browser if provided; otherwise fall back to service key (localhost only)
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
