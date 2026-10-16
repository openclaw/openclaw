import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { telegramMessageToolHints } from "./channel-actions.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import { resolveTelegramRichMessages } from "./rich-messages-config.js";

export const telegramAgentPrompt: NonNullable<ChannelPlugin["agentPrompt"]> = {
  questionInputMode: "buttons",
  messageToolHints: telegramMessageToolHints,
  messageToolCapabilities: (params) =>
    resolveTelegramInlineButtonsScope(params) === "off" ? [] : ["inlineButtons"],
  // The only Telegram formatting contract, including `<details>`. Core delivers it to
  // every turn whose output reaches this account: replies, heartbeats, cron, announces.
  inboundFormattingHints: ({ cfg, accountId }) => {
    if (resolveTelegramRichMessages({ cfg, accountId })) {
      return {
        text_markup: "markdown_telegram_rich",
        rules: [
          "Telegram rich ON (Bot API 10.3 blocks; OpenClaw maps markdown + these HTML islands to typed blocks).",
          'Supported: headings, tables (markdown, or `<table>` HTML for caption/colspan/rowspan/align), block/pull quotes (`<aside>` + `<cite>`), `<details><summary>` (+`open`), dividers `<hr/>`, sup/sub/mark/spoilers, checkbox tasks (`- [ ]` / `- [x]`, or `<ul><li><input type="checkbox" checked/>`), code, anchors `<a name="x"></a>` + `<a href="#x">label</a>`, custom emoji `<tg-emoji emoji-id="...">`, maps `<tg-map lat="" long="" zoom=""/>`, collages/slideshows `<tg-collage>`/`<tg-slideshow>`, block media e.g. `<img src="https://..."/>` (+`<figure>`/`<figcaption>`).',
          "Math: `<tg-math>` inline, `<tg-math-block>` block; never `$...$`/`\\(...\\)`.",
          "Not MarkdownV2/parse_mode.",
          "Ordinary lists, checklists (`- [ ]`, `- [x]`), bold, italic, inline code and links = Markdown (`- item`, `**bold**`, `*italic*`, `` `code` ``, `[label](url)`): Telegram rich blocks and Control UI both render it, while authored HTML shows up as literal tags in Control UI.",
          "Collapse=`<details>` (not expandable blockquote).",
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
