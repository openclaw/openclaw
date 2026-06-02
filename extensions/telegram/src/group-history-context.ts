import type {
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramGroupHistoryContextMode,
} from "openclaw/plugin-sdk/config-contracts";
import { mergeTelegramAccountConfig } from "./account-config.js";

export const DEFAULT_TELEGRAM_GROUP_HISTORY_CONTEXT_MODE: TelegramGroupHistoryContextMode =
  "mention-only";

export function resolveTelegramGroupHistoryContextMode(
  config?: Pick<TelegramAccountConfig, "includeGroupHistoryContext">,
): TelegramGroupHistoryContextMode {
  return config?.includeGroupHistoryContext ?? DEFAULT_TELEGRAM_GROUP_HISTORY_CONTEXT_MODE;
}

export function resolveTelegramGroupHistoryContextModeForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): TelegramGroupHistoryContextMode {
  return resolveTelegramGroupHistoryContextMode(
    mergeTelegramAccountConfig(params.cfg, params.accountId),
  );
}

export function includesRecentTelegramGroupHistoryContext(
  mode: TelegramGroupHistoryContextMode,
): boolean {
  return mode === "recent";
}
