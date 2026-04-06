import nodemailer from "nodemailer";
import type { ResolvedEmailAccount } from "./accounts.js";

export type SendEmailParams = {
  account: ResolvedEmailAccount;
  to: string;
  text: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
};

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const { account } = params;

  const transportOptions: nodemailer.TransportOptions = account.smtpUseSsl
    ? {
        host: account.smtpHost,
        port: account.smtpPort,
        secure: true,
        auth: { user: account.smtpUsername, pass: account.smtpPassword },
      }
    : {
        host: account.smtpHost,
        port: account.smtpPort,
        secure: false,
        requireTLS: account.smtpUseTls,
        auth: { user: account.smtpUsername, pass: account.smtpPassword },
      };

  const transporter = nodemailer.createTransport(transportOptions as any);

  const fromAddress =
    account.fromAddress || account.smtpUsername || account.imapUsername;

  const subject = params.subject ?? "OpenClaw reply";

  const message: nodemailer.SendMailOptions = {
    from: fromAddress,
    to: params.to,
    subject,
    text: params.text,
  };

  if (params.inReplyTo) {
    message.inReplyTo = params.inReplyTo;
    message.references = params.references
      ? `${params.references} ${params.inReplyTo}`
      : params.inReplyTo;
  }

  await transporter.sendMail(message);
}

export function buildReplySubject(
  baseSubject: string,
  prefix: string,
): string {
  const subject = (baseSubject || "OpenClaw reply").trim();
  if (subject.toLowerCase().startsWith("re:")) return subject;
  return `${prefix}${subject}`;
}
