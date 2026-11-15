import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveMarkdownTableMode,
  type MarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";

export type TelegramRichMessagesParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  /** Account-merged config the caller already resolved for `accountId`. */
  accountConfig?: Pick<TelegramAccountConfig, "richMessages">;
  /** Caller-authored parse_mode HTML stays on the legacy sender; rich blocks are markdown-only. */
  htmlTextMode?: boolean;
};

/** Whether this Telegram account delivers text as Bot API rich messages. */
export function resolveTelegramRichMessages(params: TelegramRichMessagesParams): boolean {
  if (params.htmlTextMode) {
    return false;
  }
  const accountConfig =
    params.accountConfig ??
    mergeTelegramAccountConfig(
      params.cfg,
      params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
    );
  return accountConfig.richMessages === true;
}

/** Markdown table mode for this account; native block tables only render on rich messages. */
export function resolveTelegramTableMode(params: TelegramRichMessagesParams): MarkdownTableMode {
  return resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
    supportsBlockTables: resolveTelegramRichMessages(params),
  });
}
