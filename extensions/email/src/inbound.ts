import type { GatewayRequestHandler, OpenClawConfig } from "openclaw/plugin-sdk";
import { getEmailRuntime } from "./runtime.js";
import { resolveEmailAccountForRecipient } from "./accounts.js";
import { checkSenderAccess } from "./access-control.js";
import { sendEmailOutbound } from "./send.js";
import type { EmailInboundPayload } from "./types.js";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
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
    const cfg = core.config.loadConfig() as OpenClawConfig;

    const account = resolveEmailAccountForRecipient({
      cfg,
      recipient: payload.to,
    });
    if (!account.enabled || !account.address) {
      respond(false, undefined, { code: 503, message: "Email channel not configured" });
      return;
    }

    // Access control: check sender against dmPolicy + allowFrom
    const senderAddress = payload.from.toLowerCase();
    const access = checkSenderAccess(senderAddress, account.dmPolicy, account.allowFrom);
    if (!access.allowed) {
      respond(false, undefined, { code: 403, message: "Sender not allowed" });
      return;
    }

    const textBody = payload.text?.trim()
      || (payload.html ? stripHtml(payload.html) : "");

    if (!textBody) {
      respond(false, undefined, { code: 400, message: "Empty email body" });
      return;
    }

    const subject = payload.subject ?? "(no subject)";
    const messageId = payload.headers?.messageId;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "email",
      accountId: account.accountId,
      peer: {
        kind: "direct",
        id: senderAddress,
      },
    });

    const rawBody = `Subject: ${subject}\n\n${textBody}`;
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Email",
      from: senderAddress,
      timestamp: Date.now(),
      envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
      body: rawBody,
    });

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
      UntrustedContext: [
        `[email_message_id: ${messageId ?? "unknown"}]`,
        `[email_subject: ${subject}]`,
        `[email_from: ${senderAddress}]`,
      ],
    });

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

    void core.channel.reply
      .dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: async (replyPayload) => {
            await deliverEmailReply({
              account,
              to: senderAddress,
              subject: subject.startsWith("Re: ") ? subject : `Re: ${subject}`,
              text: replyPayload.text ?? "",
              inReplyTo: messageId,
            });
          },
        },
      })
      .catch((err) => {
        context.logGateway.error(`[email] Dispatch failed: ${String(err)}`);
      });

    respond(true, { received: true });
  };
}

async function deliverEmailReply(params: {
  account: { outboundUrl: string; outboundToken: string };
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
}): Promise<void> {
  const { account, to, subject, text, inReplyTo } = params;

  await sendEmailOutbound({
    account,
    payload: {
      to,
      subject,
      text,
      ...(inReplyTo ? { inReplyTo } : {}),
    },
  });
}
