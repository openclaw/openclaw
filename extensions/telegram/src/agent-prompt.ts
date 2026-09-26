import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergeTelegramAccountConfig, resolveDefaultTelegramAccountId } from "./accounts.js";
import { telegramMessageToolHints } from "./channel-actions.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";

function isTelegramRichMessagesEnabled(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const selectedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  return mergeTelegramAccountConfig(cfg, selectedAccountId).richMessages === true;
}

export const telegramAgentPrompt: NonNullable<ChannelPlugin["agentPrompt"]> = {
  messageToolHints: telegramMessageToolHints,
  messageToolCapabilities: ({ cfg, accountId }) => {
    const inlineButtonsScope = resolveTelegramInlineButtonsScope({
      cfg,
      accountId: accountId ?? undefined,
    });
    return inlineButtonsScope === "off" ? [] : ["inlineButtons"];
  },
  // The only Telegram formatting contract, including `<details>`. Core delivers it to
  // every turn whose output reaches this account: replies, heartbeats, cron, announces.
  inboundFormattingHints: ({ cfg, accountId }) => {
    const richMessages = isTelegramRichMessagesEnabled(cfg, accountId);
    if (richMessages) {
      return {
        text_markup: "markdown_telegram_rich",
        rules: [
          "Telegram rich ON (Bot API 10.3 blocks; OpenClaw maps markdown + these HTML islands to typed blocks).",
          'Supported: headings, tables (markdown, or `<table>` HTML for caption/colspan/rowspan/align), block/pull quotes (`<aside>` + `<cite>`), `<details><summary>` (+`open`), dividers `<hr/>`, sup/sub/mark/spoilers, `<ul>`/`<ol>` + `<input type="checkbox" checked/>` tasks, code, anchors `<a name="x"></a>` + `<a href="#x">label</a>`, custom emoji `<tg-emoji emoji-id="...">`, maps `<tg-map lat="" long="" zoom=""/>`, collages/slideshows `<tg-collage>`/`<tg-slideshow>`, block media e.g. `<img src="https://..."/>` (+`<figure>`/`<figcaption>`).',
          "Math: `<tg-math>` inline, `<tg-math-block>` block; never `$...$`/`\\(...\\)`.",
          "Not MarkdownV2/parse_mode.",
          "Collapse=`<details>` (not expandable blockquote); structured bullets=`<ul><li>` (not literal bullets).",
          "Media https URLs only, block-level only, captions/credits when useful; buttons plain text; normal files via attachments.",
        ],
      };
    }
    return {
      text_markup: "markdown",
      rules: [
        "Telegram rich OFF. Standard Telegram formatting only; no rich tables/details/block media/formulas.",
        "Owner can enable `richMessages` for this Telegram account.",
      ],
    };
  },
  reactionGuidance: ({ cfg, accountId }) => {
    const level = resolveTelegramReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    }).agentReactionGuidance;
    return level ? { level, channelLabel: "Telegram" } : undefined;
  },
};
