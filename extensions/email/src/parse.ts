import { simpleParser } from "mailparser";
import type { EmailAttachment } from "./types.js";

export type ParsedEmail = {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  inReplyTo?: string;
  references?: string;
  text: string;
  attachments: EmailAttachment[];
};

export async function parseRawEmail(
  raw: Buffer | string,
  maxBodyChars: number,
): Promise<ParsedEmail | null> {
  let parsed;
  try {
    parsed = await simpleParser(raw);
  } catch {
    return null;
  }

  const from =
    parsed.from?.value?.[0]?.address?.toLowerCase().trim() ?? "";
  if (!from) return null;

  const subject = parsed.subject ?? "(no subject)";
  const date = parsed.date?.toISOString() ?? new Date().toISOString();
  const messageId = (parsed.messageId ?? "").trim();
  const inReplyTo = (parsed.inReplyTo ?? "").trim() || undefined;
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(" ").trim() || undefined
    : (parsed.references ?? "").trim() || undefined;

  let text = (parsed.text ?? "").trim();
  if (!text && parsed.html) {
    text = htmlToText(parsed.html);
  }
  if (text.length > maxBodyChars) {
    text = text.slice(0, maxBodyChars).trimEnd() + "\n\n[Body truncated]";
  }
  if (!text) text = "(empty email body)";

  const attachments: EmailAttachment[] = (parsed.attachments ?? []).map(
    (att) => ({
      filename: att.filename ?? "attachment",
      contentType: att.contentType ?? "application/octet-stream",
      sizeBytes: att.size ?? 0,
    }),
  );

  return { messageId, from, subject, date, inReplyTo, references, text, attachments };
}

function htmlToText(html: string): string {
  let text = html.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function buildInboundText(email: ParsedEmail): string {
  const lines: string[] = [
    "Email received.",
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Date: ${email.date}`,
  ];
  if (email.messageId) lines.push(`Message-ID: ${email.messageId}`);
  lines.push("", email.text);
  if (email.attachments.length > 0) {
    lines.push(
      "",
      "Attachments:",
      ...email.attachments.map(
        (a) => `- ${a.filename} (${a.contentType}, ${a.sizeBytes} bytes)`,
      ),
    );
  }
  return lines.join("\n");
}
