/**
 * Inbound webhook handler for the E-Claw plugin.
 *
 * Converts an E-Claw push payload into an OpenClaw reply dispatch and
 * routes any deliverable text/media back through the EclawClient.
 *
 * For bot-to-bot (`entity_message`) and `broadcast` events, the handler
 * suppresses duplicate delivery from the outbound pipeline by setting a
 * per-account active-event marker, and then posts both a channel message
 * (to update the wallpaper state) and a speak-to (to reply to the sender).
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";

import {
  clearActiveEclawEvent,
  getEclawClient,
  setActiveEclawEvent,
} from "./client-registry.js";
import { getEclawRuntime } from "./runtime.js";
import type { EclawInboundMessage } from "./types.js";
import { lookupEclawWebhookToken } from "./webhook-registry.js";

function mapMediaTypeInbound(
  mediaType: EclawInboundMessage["mediaType"],
): string | undefined {
  if (!mediaType) {
    return undefined;
  }
  if (mediaType === "photo") {
    return "image";
  }
  if (mediaType === "voice") {
    return "audio";
  }
  if (mediaType === "video") {
    return "video";
  }
  return "file";
}

function mapMediaTypeOutbound(mediaType?: string): string {
  if (mediaType === "image") {
    return "photo";
  }
  if (mediaType === "audio") {
    return "voice";
  }
  if (mediaType === "video") {
    return "video";
  }
  return mediaType || "file";
}

function buildInboundBody(msg: EclawInboundMessage): string {
  const base = msg.text || "";
  const event = msg.event ?? "message";
  if (event !== "entity_message" && event !== "broadcast") {
    return base;
  }
  if (msg.fromEntityId === undefined) {
    return base;
  }

  const senderLabel = msg.fromCharacter
    ? `Entity ${msg.fromEntityId} (${msg.fromCharacter})`
    : `Entity ${msg.fromEntityId}`;
  const eventPrefix =
    event === "broadcast"
      ? `[Broadcast from ${senderLabel}]`
      : `[Bot-to-Bot message from ${senderLabel}]`;

  const ctx = msg.eclaw_context;
  const silentToken = ctx?.silentToken ?? "[SILENT]";
  const quotaLine =
    ctx?.b2bRemaining !== undefined
      ? `[Quota: ${ctx.b2bRemaining}/${ctx.b2bMax ?? 8} remaining — output "${silentToken}" if no new info worth replying to]`
      : "";
  const missionBlock = ctx?.missionHints ?? "";

  return [eventPrefix, quotaLine, missionBlock, base].filter(Boolean).join("\n");
}

/**
 * Dispatch a decoded webhook body to the OpenClaw runtime.
 *
 * Exported (rather than kept inline) so that the channel plugin's
 * inbound adapter and any lightweight test harness can share the same
 * behavior.
 */
export async function dispatchEclawWebhookMessage(params: {
  accountId: string;
  cfg: OpenClawConfig;
  msg: EclawInboundMessage;
}): Promise<void> {
  const { accountId, cfg, msg } = params;

  if (!msg.deviceId || msg.entityId === undefined || msg.entityId === null) {
    return;
  }

  const runtime = getEclawRuntime();
  const client = getEclawClient(accountId);
  const conversationId = msg.conversationId || `${msg.deviceId}:${msg.entityId}`;
  const event = msg.event ?? "message";
  const fromEntityId = msg.fromEntityId;
  const silentToken = msg.eclaw_context?.silentToken ?? "[SILENT]";
  const body = buildInboundBody(msg);
  const ocMediaType = mapMediaTypeInbound(msg.mediaType);

  const inboundCtx: Record<string, unknown> = {
    Surface: "eclaw",
    Provider: "eclaw",
    OriginatingChannel: "eclaw",
    AccountId: accountId,
    From: msg.from,
    To: conversationId,
    OriginatingTo: msg.from,
    SessionKey: conversationId,
    Body: body,
    RawBody: body,
    CommandBody: body,
    ChatType: "direct",
  };
  if (ocMediaType && msg.mediaUrl) {
    inboundCtx.MediaType = ocMediaType;
    inboundCtx.MediaUrl = msg.mediaUrl;
  }

  const ctxPayload = runtime.channel.reply.finalizeInboundContext(inboundCtx);

  setActiveEclawEvent(accountId, event);
  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: {
          text?: string;
          mediaType?: string;
          mediaUrl?: string;
        }) => {
          if (!client) {
            return;
          }
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          const mediaUrl = payload.mediaUrl;
          const outboundMediaType = mediaUrl
            ? mapMediaTypeOutbound(payload.mediaType)
            : undefined;

          // Silent-token: hard stop, regardless of media.
          if (text === silentToken) {
            return;
          }

          // Nothing to send.
          if (!text && !mediaUrl) {
            return;
          }

          // Media-only (no text) goes straight through as a single call.
          if (!text) {
            await client.sendMessage(
              "",
              "IDLE",
              outboundMediaType,
              mediaUrl,
            );
            return;
          }

          // Text + (optional) media delivery.
          //
          // The E-Claw /api/channel/message endpoint accepts text and
          // media in a single call, so when both are present we ship
          // them together rather than dropping one or splitting them.
          if (
            (event === "entity_message" || event === "broadcast") &&
            fromEntityId !== undefined
          ) {
            // Update own wallpaper (with media if any) and reply to
            // the sender with the text. speakTo is text-only, so any
            // media is attached to the wallpaper sendMessage call.
            await client.sendMessage(text, "IDLE", outboundMediaType, mediaUrl);
            await client.speakTo(fromEntityId, text, false);
            return;
          }

          await client.sendMessage(text, "IDLE", outboundMediaType, mediaUrl);
        },
        onError: (err: unknown, info?: { kind?: string }) => {
          // Don't silently drop delivery failures — surface them via
          // the plugin runtime logger so operators can see partial
          // failures in the OpenClaw logs. If the runtime has no error
          // sink wired up (shouldn't happen at runtime), the message is
          // dropped rather than leaking to stdout — this keeps the
          // extension free of production lint suppressions.
          const message = err instanceof Error ? err.message : String(err);
          const kind = info?.kind ? ` ${info.kind}` : "";
          const line = `eclaw: reply${kind} delivery failed: ${message}`;
          try {
            const runtime = getEclawRuntime() as unknown as {
              error?: (msg: string) => void;
            };
            if (typeof runtime?.error === "function") {
              runtime.error(line);
            }
          } catch {
            /* runtime not initialised — drop silently */
          }
        },
      },
    });
  } finally {
    clearActiveEclawEvent(accountId);
  }
}

/**
 * HTTP handler for the shared `/eclaw-webhook` route. Looks up the target
 * account by the Bearer token in the Authorization header and dispatches
 * the payload to `dispatchEclawWebhookMessage`.
 */
export async function handleEclawWebhookRequest(params: {
  cfg: OpenClawConfig;
  authHeader: string | undefined;
  body: EclawInboundMessage;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const entry = lookupEclawWebhookToken(params.authHeader);
  if (!entry) {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  try {
    await dispatchEclawWebhookMessage({
      accountId: entry.accountId,
      cfg: params.cfg,
      msg: params.body,
    });
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 500, body: { error: "dispatch_failed" } };
  }
}
