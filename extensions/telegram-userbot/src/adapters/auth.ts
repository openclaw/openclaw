/**
 * Auth adapter for the telegram-userbot channel.
 *
 * Handles login flow. Interactive auth (phone code + 2FA) will be
 * enhanced in TASK_13; for now provides the adapter shell.
 */

import type { ChannelAuthAdapter } from "openclaw/plugin-sdk";

export const telegramUserbotAuthAdapter: ChannelAuthAdapter = {
  login: async ({ cfg, accountId, runtime, verbose }) => {
    // Interactive authentication (phone code + 2FA password) will be
    // implemented in TASK_13. For now, this is a no-op placeholder
    // that informs the user to set up a session manually.
    const label = accountId ?? "default";
    if (verbose) {
      console.log(
        `[telegram-userbot] login for account "${label}" — interactive auth will be available in a future update.`,
      );
    }
  },
};
