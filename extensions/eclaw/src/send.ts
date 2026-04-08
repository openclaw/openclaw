/**
 * Outbound send helpers for the E-Claw channel plugin.
 *
 * These are invoked from the ChannelPlugin outbound adapter when the
 * OpenClaw runtime wants to deliver a text or media reply to an E-Claw
 * user. For bot-to-bot / broadcast events the gateway handles delivery
 * inline (see webhook-handler.ts), so the outbound path short-circuits
 * in that case via `getActiveEclawEvent()`.
 *
 * The suppression flag is read from an AsyncLocalStorage context
 * (see client-registry.ts) so that concurrent unrelated outbound sends
 * on the same account are NOT dropped. PR #62934 review round 5
 * (codex send.ts P1 item) — the previous global-Map implementation
 * caused silent message loss under concurrency.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-channel-plugins.md §"Outbound adapter" —
 *     the outbound.sendText / outbound.sendMedia contract returns
 *     `{channel, messageId, chatId, ok?}`.
 *   - docs/plugins/architecture.md §"Channel boundary" —
 *     channel-owned outbound logic stays inside the extension; core
 *     never constructs channel payloads directly.
 */

import type { EclawClient } from "./client.js";
import { getActiveEclawEvent, getEclawClient } from "./client-registry.js";

type SendOutcome = {
  channel: "eclaw";
  messageId: string;
  chatId: string;
  ok?: boolean;
};

function formatSendResult(
  to: string | null | undefined,
  ok: boolean,
): SendOutcome {
  return {
    channel: "eclaw",
    messageId: `eclaw-${Date.now()}`,
    chatId: (to ?? "").toString(),
    ok,
  };
}

function mapMediaType(mediaType?: string): string {
  return mediaType === "image"
    ? "photo"
    : mediaType === "audio"
      ? "voice"
      : mediaType === "video"
        ? "video"
        : mediaType || "file";
}

function shouldSuppress(accountId: string): boolean {
  const event = getActiveEclawEvent(accountId);
  return event === "entity_message" || event === "broadcast";
}

async function sendViaClient(
  client: EclawClient,
  text: string,
  mediaType?: string,
  mediaUrl?: string,
): Promise<boolean> {
  const result = await client.sendMessage(text, "IDLE", mediaType, mediaUrl);
  return Boolean(result.success);
}

export async function sendEclawText(params: {
  accountId?: string | null;
  to?: string | null;
  text: string;
}): Promise<SendOutcome> {
  const accountId = params.accountId ?? "default";
  if (shouldSuppress(accountId)) {
    return formatSendResult(params.to, true);
  }

  const client = getEclawClient(accountId);
  if (!client) {
    return formatSendResult(params.to, false);
  }

  try {
    const ok = await sendViaClient(client, params.text);
    return formatSendResult(params.to, ok);
  } catch {
    return formatSendResult(params.to, false);
  }
}

export async function sendEclawMedia(params: {
  accountId?: string | null;
  to?: string | null;
  text?: string;
  mediaType?: string;
  mediaUrl?: string;
}): Promise<SendOutcome> {
  const accountId = params.accountId ?? "default";
  if (shouldSuppress(accountId)) {
    return formatSendResult(params.to, true);
  }

  const client = getEclawClient(accountId);
  if (!client) {
    return formatSendResult(params.to, false);
  }

  try {
    const mediaType = mapMediaType(params.mediaType);
    const text = params.text || `[${mediaType}]`;
    const ok = await sendViaClient(client, text, mediaType, params.mediaUrl);
    return formatSendResult(params.to, ok);
  } catch {
    return formatSendResult(params.to, false);
  }
}
