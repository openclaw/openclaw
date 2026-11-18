import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveTelegramAccount, resolveTelegramAccountConfig } from "./accounts.js";

/** Preserve the inbound bot, including credentials resolved outside the config snapshot. */
export function prepareTelegramFinalDeliveryConfig(
  cfg: OpenClawConfig,
  accountId: string,
  admittedToken: string,
): OpenClawConfig {
  const token = admittedToken.trim();
  const account = resolveTelegramAccount({ cfg, accountId });
  if (
    !token ||
    !account.enabled ||
    account.accountId !== normalizeAccountId(accountId) ||
    account.token.trim() !== token
  ) {
    const message = "The Telegram reply sender changed during this turn; delivery was not started.";
    throw new PlatformMessageNotDispatchedError(message, {
      cause: new Error(message),
      retryable: false,
    });
  }
  const telegram = cfg.channels?.telegram;
  const accounts = telegram?.accounts;
  const key =
    accounts && Object.hasOwn(accounts, account.accountId)
      ? account.accountId
      : (Object.keys(accounts ?? {}).find(
          (candidateKey) => normalizeAccountId(candidateKey) === account.accountId,
        ) ?? account.accountId);
  // Resolve once, then pin that exact credential for every part of this send.
  // A token file or environment change during async preparation cannot select another bot.
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      telegram: {
        ...telegram,
        accounts: {
          ...accounts,
          [key]: {
            ...resolveTelegramAccountConfig(cfg, account.accountId),
            tokenFile: undefined,
            botToken: token,
          },
        },
      },
    },
  };
}
