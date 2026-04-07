import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

interface OutboundWhitelistConfig {
  allowedRecipients?: string[];
}

const ALLOW_MESSAGE = Object.freeze({});
const BLOCK_MESSAGE = Object.freeze({ cancel: true });

export default definePluginEntry({
  id: "outbound-whitelist",
  name: "Outbound Whitelist",
  description: "Blocks outbound messages to recipients not on a configured allowlist",

  register(api) {
    const config = api.pluginConfig as OutboundWhitelistConfig | undefined;
    const whitelist = Object.freeze(
      (config?.allowedRecipients ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
    );
    const isAllRecipientsAllowed = whitelist.length === 0 || whitelist.includes("*");

    if (isAllRecipientsAllowed) {
      api.logger.info("Outbound whitelist inactive: All messages permitted.");
    } else {
      api.logger.info(
        `Outbound whitelist is active — ${whitelist.length} allowed recipient(s): ${whitelist.join(", ")}`,
      );
      api.on("message_sending", ({ to }) =>
        isRecipientAllowed(to, whitelist) ? ALLOW_MESSAGE : blockMessage(to, api.logger),
      );
    }
  },
});

/**
 * Check whether a recipient is on the whitelist.
 *
 * Uses `includes()` for matching so that bare IDs (e.g., Discord user ID "855551080707391519")
 * match against prefixed `to` values (e.g., "channel:855551080707391519"). Allowlist entries are typically long enough
 * (phone numbers, group JIDs, Discord IDs) that accidental substring collisions should not be a practical concern.
 */
function isRecipientAllowed(to: string, whitelist: readonly string[]): boolean {
  return whitelist.some((pattern) => to.includes(pattern));
}

/**
 * Cancels delivery for a given message event
 */
function blockMessage(to: string, logger: PluginLogger): { cancel: boolean } {
  logger.info(`Blocked outbound message to ${to} (not on allowlist)`);
  return BLOCK_MESSAGE;
}
