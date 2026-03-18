/**
 * Resolve the Telegram Bot API base URL.
 *
 * By default this is `https://api.telegram.org`. Set the `TELEGRAM_BOT_API_HOST`
 * environment variable to point at a self-hosted Bot API server, e.g.:
 *   TELEGRAM_BOT_API_HOST=https://my-bot-api.example.com
 *   TELEGRAM_BOT_API_HOST=my-bot-api.example.com   # https:// is assumed
 */
export function resolveTelegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TELEGRAM_BOT_API_HOST?.trim();
  if (!raw) {
    return "https://api.telegram.org";
  }
  // Normalize: add https:// if no protocol is present, then strip trailing slash.
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProto.replace(/\/+$/, "");
}

/**
 * Extract the hostname from the resolved Telegram Bot API base URL.
 */
export function resolveTelegramApiHostname(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveTelegramApiBase(env);
  try {
    return new URL(base).hostname;
  } catch {
    return "api.telegram.org";
  }
}
