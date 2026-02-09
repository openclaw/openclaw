/**
 * Email tool — IMAP (read/monitor) + SMTP (send).
 * Uses imapflow for reading and nodemailer for sending.
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ImapConfig, SmtpConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Email types
// ---------------------------------------------------------------------------

export interface EmailMessage {
  uid: number;
  from: string;
  to: string[];
  subject: string;
  date: string;
  body: string;
  isRead: boolean;
}

export interface EmailDraft {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

// ---------------------------------------------------------------------------
// IMAP — Read emails
// ---------------------------------------------------------------------------

/**
 * Connect to IMAP and fetch recent emails.
 */
export async function fetchEmails(
  config: ImapConfig,
  opts?: { folder?: string; limit?: number; unseen?: boolean },
): Promise<EmailMessage[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: config.auth,
    logger: false,
  });

  try {
    await client.connect();

    const folder = opts?.folder ?? "INBOX";
    const lock = await client.getMailboxLock(folder);

    try {
      const messages: EmailMessage[] = [];
      const limit = opts?.limit ?? 20;

      // Build search criteria
      const searchCriteria: any = opts?.unseen ? { seen: false } : { all: true };
      const uids = await client.search(searchCriteria);
      if (!uids || !Array.isArray(uids)) return [];

      // Get the most recent N messages
      const recentUids = uids.slice(-limit);
      if (recentUids.length === 0) return [];

      for await (const msg of client.fetch(recentUids, {
        envelope: true,
        bodyStructure: true,
        source: true,
      })) {
        const envelope = msg.envelope ?? {} as any;
        messages.push({
          uid: msg.uid,
          from: envelope.from?.[0]?.address ?? "unknown",
          to: (envelope.to ?? []).map((a: any) => a.address ?? "unknown"),
          subject: envelope.subject ?? "(no subject)",
          date: envelope.date?.toISOString() ?? new Date().toISOString(),
          body: msg.source?.toString("utf-8").slice(0, 5000) ?? "",
          isRead: msg.flags?.has("\\Seen") ?? false,
        });
      }

      return messages.reverse(); // Most recent first
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/**
 * Search emails by query.
 */
export async function searchEmails(
  config: ImapConfig,
  query: string,
  opts?: { folder?: string; limit?: number },
): Promise<EmailMessage[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: config.auth,
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(opts?.folder ?? "INBOX");

    try {
      const uids = await client.search({
        or: [{ subject: query }, { body: query }, { from: query }],
      });
      if (!uids || !Array.isArray(uids)) return [];

      const limit = opts?.limit ?? 10;
      const recentUids = uids.slice(-limit);

      const messages: EmailMessage[] = [];
      for await (const msg of client.fetch(recentUids, {
        envelope: true,
        source: true,
      })) {
        const envelope = msg.envelope ?? {} as any;
        messages.push({
          uid: msg.uid,
          from: envelope.from?.[0]?.address ?? "unknown",
          to: (envelope.to ?? []).map((a: any) => a.address ?? "unknown"),
          subject: envelope.subject ?? "(no subject)",
          date: envelope.date?.toISOString() ?? new Date().toISOString(),
          body: msg.source?.toString("utf-8").slice(0, 5000) ?? "",
          isRead: msg.flags?.has("\\Seen") ?? false,
        });
      }

      return messages.reverse();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// SMTP — Send emails
// ---------------------------------------------------------------------------

/**
 * Send an email via SMTP.
 */
export async function sendEmail(
  config: SmtpConfig,
  draft: EmailDraft,
): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  const to = Array.isArray(draft.to) ? draft.to.join(", ") : draft.to;

  const info = await transporter.sendMail({
    to,
    subject: draft.subject,
    text: draft.body,
    cc: draft.cc?.join(", "),
    bcc: draft.bcc?.join(", "),
  });

  return { messageId: info.messageId };
}

// ---------------------------------------------------------------------------
// IMAP IDLE — Real-time email monitoring
// ---------------------------------------------------------------------------

export interface EmailMonitorCallbacks {
  onNewEmail: (email: EmailMessage) => void | Promise<void>;
  onError: (error: Error) => void;
}

/**
 * Start IMAP IDLE monitoring for new emails.
 * Returns a stop function.
 */
export async function startEmailMonitor(
  config: ImapConfig,
  callbacks: EmailMonitorCallbacks,
): Promise<() => Promise<void>> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: config.auth,
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  // Track the last known UID
  let lastUid = (client as any).mailbox?.uidNext ?? 1;

  client.on("exists", async (data: { count: number }) => {
    try {
      // Fetch new messages since last known UID
      const newMessages: EmailMessage[] = [];
      for await (const msg of client.fetch(`${lastUid}:*`, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        if (msg.uid >= lastUid) {
          const envelope = msg.envelope ?? {} as any;
          newMessages.push({
            uid: msg.uid,
            from: envelope.from?.[0]?.address ?? "unknown",
            to: (envelope.to ?? []).map((a: any) => a.address ?? "unknown"),
            subject: envelope.subject ?? "(no subject)",
            date: envelope.date?.toISOString() ?? new Date().toISOString(),
            body: msg.source?.toString("utf-8").slice(0, 5000) ?? "",
            isRead: false,
          });
          lastUid = msg.uid + 1;
        }
      }

      for (const email of newMessages) {
        await callbacks.onNewEmail(email);
      }
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // Start IDLE
  await client.idle();

  // Return stop function
  return async () => {
    lock.release();
    await client.logout();
  };
}
