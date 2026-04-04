import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTelegramSend, resolveTelegramTokenHelper } from "./outbound-base.js";

export const telegramPairingText = {
  idLabel: "telegramUserId",
  message: PAIRING_APPROVED_MESSAGE,
  normalizeAllowEntry: createPairingPrefixStripper(/^(telegram|tg):/i),
  notify: async ({
    cfg,
    id,
    message,
    accountId,
  }: {
    cfg: OpenClawConfig;
    id: string;
    message: string;
    accountId?: string | null;
  }) => {
    const resolveToken = await resolveTelegramTokenHelper();
    const { token } = await resolveToken(cfg, { accountId });
    if (!token) {
      throw new Error("telegram token not configured");
    }
    await resolveTelegramSend()(id, message, { token, accountId: accountId ?? undefined });
  },
};
