/**
 * Outbound adapter: sends emails via InboxAPI.
 */

import { resolveAccount } from "./accounts.js";
import { resolveAccessToken } from "./auth.js";
import type { InboxApiClientOptions } from "./client.js";
import { sendEmail, sendReply } from "./client.js";
import type { ResolvedInboxApiAccount } from "./types.js";

const CHANNEL_ID = "inboxapi";

/**
 * Build client options from a resolved account.
 */
async function buildClientOptions(
  account: ResolvedInboxApiAccount,
): Promise<InboxApiClientOptions> {
  const accessToken = await resolveAccessToken(account);
  return {
    mcpEndpoint: account.mcpEndpoint,
    accessToken,
    fromName: account.fromName,
  };
}

/**
 * Send a text reply or new email.
 * If replyToId is present, uses send_reply to maintain threading.
 * Otherwise sends a new email with auto-generated subject.
 */
export async function sendOutboundText({
  to,
  text,
  replyToId,
  subject,
  accountId,
  cfg,
}: {
  to: string;
  text: string;
  replyToId?: string;
  subject?: string;
  accountId?: string;
  cfg: any;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  const account = resolveAccount(cfg ?? {}, accountId);
  const clientOpts = await buildClientOptions(account);

  if (!clientOpts.accessToken) {
    throw new Error("InboxAPI access token not configured");
  }

  let messageId: string | undefined;

  if (replyToId) {
    // Reply to an existing email thread
    const result = await sendReply(clientOpts, {
      email_id: replyToId,
      body: text,
    });
    messageId = result.messageId;
  } else {
    // New email
    const emailTo = to.replace(/^inboxapi:/i, "");
    const result = await sendEmail(clientOpts, {
      to: emailTo,
      subject: subject ?? "Message from OpenClaw",
      body: text,
    });
    messageId = result.messageId;
  }

  return {
    channel: CHANNEL_ID,
    messageId: messageId ?? `inboxapi-${Date.now()}`,
    chatId: to,
  };
}
