/** SMTP / email-proxy config (the local `/api/send-email` service). */
export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  password?: string; // optional Bearer for the proxy
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an email through the local email-proxy HTTP service (same endpoint the
 * report-generator plugin uses). Self-contained per the extension boundary.
 */
export async function sendEmail(cfg: SmtpConfig, msg: EmailMessage): Promise<void> {
  const endpoint = `http://${cfg.host}:${cfg.port}/api/send-email`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.password ? { Authorization: `Bearer ${cfg.password}` } : {}),
    },
    body: JSON.stringify({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html ?? `<pre style="font-family:inherit;white-space:pre-wrap">${msg.text}</pre>`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Email proxy returned ${res.status} ${res.statusText}`);
  }
}

/** Resolve SMTP config from plugin config or env; undefined when not configured. */
export function resolveSmtpConfig(pluginConfig: Record<string, unknown>): SmtpConfig | undefined {
  const block = pluginConfig.smtp as Record<string, unknown> | undefined;
  const host = (block?.host as string) ?? process.env.SMTP_HOST ?? "";
  const port = Number(block?.port ?? process.env.SMTP_PORT ?? 0);
  const from = (block?.from as string) ?? process.env.SMTP_FROM ?? "";
  if (!host || !Number.isFinite(port) || port <= 0 || !from) {
    return undefined;
  }
  return { host, port, from, password: (block?.password as string) ?? process.env.SMTP_PASSWORD };
}
