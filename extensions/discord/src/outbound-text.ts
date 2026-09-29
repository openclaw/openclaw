import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { renderDiscordMarkdown } from "./markdown.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";

export function prepareDiscordOutboundText(
  text: string,
  params: {
    cfg: OpenClawConfig;
    account: Pick<ResolvedDiscordAccount, "accountId" | "config">;
    tableMode?: MarkdownTableMode;
    textLimit?: number;
  },
) {
  const { account } = params;
  const tableMode =
    params.tableMode ??
    resolveMarkdownTableMode({ cfg: params.cfg, channel: "discord", accountId: account.accountId });
  const renderedText = renderDiscordMarkdown(text, tableMode);
  // Both transports measure chunks after rendering and alias expansion; titles retain display names.
  return {
    renderedText,
    textLimit:
      typeof params.textLimit === "number" && Number.isFinite(params.textLimit)
        ? Math.max(1, Math.min(Math.floor(params.textLimit), 2000))
        : undefined,
    textWithMentions: rewriteDiscordKnownMentions(renderedText, {
      accountId: account.accountId,
      mentionAliases: account.config.mentionAliases,
    }),
  };
}
