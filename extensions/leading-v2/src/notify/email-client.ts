import nodemailer from "nodemailer";

/** SMTP config — direct SMTP send (SSL/465 or STARTTLS/587), like 定时任务.py's smtplib.SMTP_SSL. */
export interface SmtpConfig {
  host: string; // e.g. smtp.exmail.qq.com
  port: number; // 465 (SSL) | 587 (STARTTLS) | 25
  user: string; // login account = sender, e.g. zhoufeng@ibtai.com
  password: string; // 授权码 (client auth code, not the login password)
  from?: string; // From header; defaults to `user`
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let cachedTransport: nodemailer.Transporter | null = null;
let cachedKey = "";

function getTransport(cfg: SmtpConfig): nodemailer.Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (!cachedTransport || cachedKey !== key) {
    cachedTransport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465, // implicit TLS on 465; STARTTLS otherwise
      auth: { user: cfg.user, pass: cfg.password },
    });
    cachedKey = key;
  }
  return cachedTransport;
}

/** Send an email directly via SMTP (mirrors 定时任务.py: SMTP_SSL + login + sendmail). */
export async function sendEmail(cfg: SmtpConfig, msg: EmailMessage): Promise<void> {
  await getTransport(cfg).sendMail({
    from: cfg.from || cfg.user,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html ?? `<pre style="font-family:inherit;white-space:pre-wrap">${msg.text}</pre>`,
  });
}

/** Resolve SMTP config from plugin config or env; undefined when not configured. */
export function resolveSmtpConfig(pluginConfig: Record<string, unknown>): SmtpConfig | undefined {
  const block = pluginConfig.smtp as Record<string, unknown> | undefined;
  const host = (block?.host as string) ?? process.env.SMTP_HOST ?? "";
  const port = Number(block?.port ?? process.env.SMTP_PORT ?? 0);
  const user = (block?.user as string) ?? process.env.SMTP_USER ?? "";
  const password = (block?.password as string) ?? process.env.SMTP_PASSWORD ?? "";
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !password) {
    return undefined;
  }
  return { host, port, user, password, from: (block?.from as string) ?? process.env.SMTP_FROM ?? user };
}
