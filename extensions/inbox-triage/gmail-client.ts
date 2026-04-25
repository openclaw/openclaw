/**
 * Minimal Gmail wrapper around `googleapis`. We only need:
 *   - listUnread(sinceMs)  : recent unread threads with snippets
 *   - sendReply(threadId, body, subject?, to?) : send a reply in a thread
 *
 * Uses long-lived refresh-token OAuth (Desktop client) so the gateway can
 * run headlessly on the VPS — the user does the consent flow once via the
 * `pnpm gmail:auth` helper.
 */

import { OAuth2Client } from "google-auth-library";
import { gmail_v1, google } from "googleapis";

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  internalDateMs: number;
};

export class GmailClient {
  private readonly gmail: gmail_v1.Gmail;
  private readonly oauth: OAuth2Client;

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    user: string;
  }) {
    this.oauth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
    this.oauth.setCredentials({ refresh_token: opts.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth: this.oauth });
  }

  async listUnread(sinceMs: number, maxResults = 50): Promise<GmailMessageSummary[]> {
    const sinceSec = Math.floor(sinceMs / 1000);
    const list = await this.gmail.users.messages.list({
      userId: "me",
      q: `is:unread after:${sinceSec}`,
      maxResults,
    });

    const ids = (list.data.messages ?? []).map((m) => m.id).filter(Boolean) as string[];
    if (ids.length === 0) {
      return [];
    }

    const summaries: GmailMessageSummary[] = [];
    for (const id of ids) {
      const msg = await this.gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject"],
      });
      const headers = msg.data.payload?.headers ?? [];
      const get = (name: string) =>
        headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
      summaries.push({
        id: msg.data.id ?? id,
        threadId: msg.data.threadId ?? id,
        from: get("From"),
        to: get("To"),
        subject: get("Subject"),
        snippet: msg.data.snippet ?? "",
        internalDateMs: Number(msg.data.internalDate ?? Date.now()),
      });
    }
    return summaries;
  }

  /**
   * Send a reply in an existing thread. Marks the original thread as read.
   */
  async sendReply(opts: {
    threadId: string;
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<void> {
    const subject = opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`;
    const headers = [
      `To: ${opts.to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
    ];
    if (opts.inReplyTo) {
      headers.push(`In-Reply-To: <${opts.inReplyTo}>`);
      headers.push(`References: <${opts.inReplyTo}>`);
    }
    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${opts.body}`).toString("base64url");

    await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: opts.threadId },
    });
    await this.gmail.users.threads.modify({
      userId: "me",
      id: opts.threadId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  }
}
