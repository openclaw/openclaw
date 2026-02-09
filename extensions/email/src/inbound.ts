/**
 * Gateway RPC handler for "email.inbound".
 *
 * Called by American Claw when an inbound email arrives via Cloudflare
 * Email Routing. Builds a MsgContext, records the session, and dispatches
 * the message to the agent for processing. The agent's reply is sent
 * back via the outbound adapter (HTTP POST to American Claw).
 */

import type { GatewayRequestHandler, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { getEmailRuntime } from "./runtime.js";
import { resolveEmailAccount } from "./accounts.js";
import type { EmailInboundPayload } from "./types.js";

/**
 * Strip HTML tags for a plain-text fallback.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function createEmailInboundHandler(): GatewayRequestHandler {
  return async (opts) => {
    const { params, respond, context } = opts;
    const payload = params as unknown as EmailInboundPayload;

    if (!payload.from || !payload.to) {
      respond(false, undefined, { code: 400, message: "Missing from or to" });
      return;
    }

    const core = getEmailRuntime();
    const cfg = context.deps.config as OpenClawConfig;

    const account = resolveEmailAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    if (!account.enabled || !account.address) {
      respond(false, undefined, { code: 503, message: "Email channel not configured" });
      return;
    }

    // Build plain text body
    const textBody = payload.text?.trim()
      || (payload.html ? stripHtml(payload.html) : "");

    if (!textBody) {
      respond(false, undefined, { code: 400, message: "Empty email body" });
      return;
    }

    const subject = payload.subject ?? "(no subject)";
    const messageId = payload.headers?.messageId;

    // Resolve the agent route for this email sender
    const senderAddress = payload.from.toLowerCase();
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "email",
      accountId: DEFAULT_ACCOUNT_ID,
      peer: {
        kind: "direct",
        id: senderAddress,
      },
    });

    // Build the agent-facing message with email envelope context
    const rawBody = `Subject: ${subject}\n\n${textBody}`;
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Email",
      from: senderAddress,
      timestamp: Date.now(),
      envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
      body: rawBody,
    });

    // Finalize inbound context (sets CommandAuthorized, etc.)
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: `email:${senderAddress}`,
      To: `email:${account.address}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: subject,
      SenderName: senderAddress,
      SenderId: senderAddress,
      Provider: "email",
      Surface: "email",
      MessageSid: messageId,
      OriginatingChannel: "email",
      OriginatingTo: senderAddress,
      // Carry email metadata for outbound threading
      UntrustedContext: [
        `[email_message_id: ${messageId ?? "unknown"}]`,
        `[email_subject: ${subject}]`,
        `[email_from: ${senderAddress}]`,
      ],
    });

    // Record the inbound session
    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        context.logGateway.error(`[email] Failed to record session: ${String(err)}`);
      },
    });

    // Dispatch to agent and deliver reply via outbound
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "email",
      accountId: DEFAULT_ACCOUNT_ID,
    });
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "email",
      accountId: DEFAULT_ACCOUNT_ID,
    });

    // Fire-and-forget: dispatch to agent; reply will be sent via outbound adapter
    void core.channel.reply
      .dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (replyPayload) => {
            // Send reply email via American Claw outbound API
            await deliverEmailReply({
              account,
              to: senderAddress,
              subject: subject.startsWith("Re: ") ? subject : `Re: ${subject}`,
              text: replyPayload.text ?? "",
              inReplyTo: messageId,
            });
          },
        },
        replyOptions: {
          onModelSelected,
        },
      })
      .catch((err) => {
        context.logGateway.error(`[email] Dispatch failed: ${String(err)}`);
      });

    // Respond immediately to the gateway caller (American Claw webhook)
    respond(true, { received: true });
  };
}

/**
 * Send an email reply via American Claw's /api/email/outbound endpoint.
 */
async function deliverEmailReply(params: {
  account: { outboundUrl: string; outboundToken: string };
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
}): Promise<void> {
  const { account, to, subject, text, inReplyTo } = params;

  if (!account.outboundUrl || !account.outboundToken) {
    throw new Error("Email outbound not configured: missing outboundUrl or outboundToken");
  }

  const body: Record<string, string> = {
    to,
    subject,
    text,
  };
  if (inReplyTo) {
    body.inReplyTo = inReplyTo;
  }

  const response = await fetch(account.outboundUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.outboundToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(
      `Email outbound failed (${response.status}): ${errorText}`,
    );
  }
}
