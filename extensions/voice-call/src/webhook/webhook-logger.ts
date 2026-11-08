// Prefixes every voice-call webhook log line with the channel tag. Extracted
// from webhook.ts, which is over its line cap and cannot absorb growth.
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/** Wrap a raw logger so each line carries the `[voice-call]` prefix. */
export function createPrefixedWebhookLogger(rawLogger: PluginLogger): PluginLogger {
  const rawDebug = rawLogger.debug;
  return {
    info: (msg: string) => rawLogger.info(`[voice-call] ${msg}`),
    warn: (msg: string) => rawLogger.warn(`[voice-call] ${msg}`),
    error: (msg: string) => rawLogger.error(`[voice-call] ${msg}`),
    debug: rawDebug ? (msg: string) => rawDebug(`[voice-call] ${msg}`) : undefined,
  };
}
