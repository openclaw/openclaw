import nodemailer from "nodemailer";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ResolvedEmailAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  from?: string;
  subjectPrefix?: string;
  config: {
    dmPolicy?: string;
    allowFrom?: Array<string | number>;
  };
};

export function normalizeEmailTarget(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed
    .replace(/^email:/i, "")
    .replace(/^mailto:/i, "")
    .trim()
    .replace(/^<|>$/g, "");
  if (!EMAIL_PATTERN.test(stripped)) {
    throw new Error(`Invalid email target: ${raw}`);
  }
  return stripped.toLowerCase();
}

export async function probeEmailAccount(account: ResolvedEmailAccount): Promise<{
  ok: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  error?: string;
}> {
  if (!account.configured || !account.smtpHost) {
    return { ok: false, error: "email account is not fully configured" };
  }
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    ...(account.smtpUser
      ? {
          auth: {
            user: account.smtpUser,
            pass: account.smtpPass,
          },
        }
      : {}),
  });
  try {
    await transport.verify();
    return {
      ok: true,
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
    };
  } catch (err) {
    return {
      ok: false,
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendMessageEmail(params: {
  account: ResolvedEmailAccount;
  to: string;
  text: string;
}): Promise<{ messageId: string; to: string }> {
  const to = normalizeEmailTarget(params.to);
  if (!params.account.configured || !params.account.smtpHost || !params.account.from) {
    throw new Error("Email channel is not configured (requires smtpHost + from)");
  }
  const transport = nodemailer.createTransport({
    host: params.account.smtpHost,
    port: params.account.smtpPort,
    secure: params.account.smtpSecure,
    ...(params.account.smtpUser
      ? {
          auth: {
            user: params.account.smtpUser,
            pass: params.account.smtpPass,
          },
        }
      : {}),
  });

  const subjectPrefix = params.account.subjectPrefix?.trim() || "OpenClaw";
  const info = await transport.sendMail({
    from: params.account.from,
    to,
    subject: `${subjectPrefix} message`,
    text: params.text ?? "",
  });

  return {
    messageId: info.messageId || `email-${Date.now()}`,
    to,
  };
}
