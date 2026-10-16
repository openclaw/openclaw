// Feishu plugin module plans the card-or-post cut of one chat text send.
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import {
  chunkFeishuPostMarkdown,
  postFencesSurvive,
  materializeFeishuPostMarkdownSoftBreaks,
} from "./markdown.js";
import type { FeishuOutboundDeliveryOptions } from "./outbound-delivery-options.js";
import { FEISHU_TEXT_CHUNK_LIMIT } from "./outbound-send-result.js";
import {
  hasCardMarkdownTable,
  hasUndrawableCardTable,
  shouldUseCard,
  withinCardTableLimit,
  cardCarriesWholeTable,
} from "./presentation-card.js";
import { chunkFeishuCardMarkdown, type CardHeaderConfig } from "./send.js";

// Decides whether one chat text send goes out as a card or a post and cuts it into
// the messages the reader gets. The send loop only reads what comes back.
export function planFeishuOutboundText(
  params: Pick<FeishuOutboundDeliveryOptions, "formatting"> & {
    cfg: ClawdbotConfig;
    accountId?: string;
    text: string;
    header?: CardHeaderConfig;
  },
) {
  const { cfg, accountId, text, formatting } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  // Resolve with block support so a configured or default block keeps native
  // tables on cards. An explicit off, bullets or code converts before routing,
  // so the mode applies in auto mode too, and a raw table promotes the message
  // to a card only when it renders natively. Card content is never touched by
  // the post-md newline normalization below.
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    supportsBlockTables: true,
  });
  const nativeTables = tableMode === "block";
  const tableText = nativeTables ? text : convertMarkdownTables(text, tableMode);
  // off has no card representation, since a card renderer parses the pipes, so a
  // table that stays raw takes the post path even when cards were requested. The
  // card renderer's own parser answers what counts as a table here.
  // `shouldUseCard` answers true for a fenced block before it looks at tables, so an
  // auto send carrying both a fence and a shape the card renderer cannot draw would
  // reach a card and lose those rows. Ask about drawability here too. An explicit
  // `card` render mode still wins, which is the direct-send behaviour this change keeps.
  // Core plans its own text units against the delivery's formatting first and the resolved
  // account only after it, and a delivery that asks for a 1,000-character cut means the
  // messages the reader gets, not the units core would have cut. Registering
  // `sendFormattedText` moved the cut here, so this side reads the same order: the
  // per-delivery value wins, and the account setting stands when there is none.
  const postLimit =
    formatting?.textLimit ??
    resolveTextChunkLimit(cfg, "feishu", account.accountId, {
      fallbackLimit: FEISHU_TEXT_CHUNK_LIMIT,
    });
  const postChunkMode = formatting?.chunkMode ?? resolveChunkMode(cfg, "feishu", account.accountId);
  // A card carries a table as one component and the card chunker cuts on lines without
  // repeating the header and its delimiter, so every card after the first shows those
  // rows as raw pipes. A table that does not fit one card takes the post path instead,
  // which renders it as a fenced block that survives the cut. This branch taught the
  // promotion to recognise pipe-less tables, which used to miss it and land here anyway,
  // and the same cut applies to the piped ones the promotion already accepted.
  const cardKeepsTableWhole = cardCarriesWholeTable(tableText, (candidate) =>
    chunkFeishuCardMarkdown({
      text: candidate,
      limit: postLimit,
      mode: postChunkMode,
      header: params.header,
    }),
  );
  const useCard =
    (renderMode === "card" ||
      (renderMode === "auto" &&
        shouldUseCard(tableText, nativeTables) &&
        !hasUndrawableCardTable(tableText))) &&
    !(tableMode === "off" && hasCardMarkdownTable(tableText)) &&
    withinCardTableLimit(tableText) &&
    cardKeepsTableWhole;

  // Post rendering has no native tables, so block falls back to code there.
  // Tables need contiguous source rows, so convert them before the parser
  // materializes prose soft breaks for Feishu post rendering.
  const postTableText = nativeTables ? convertMarkdownTables(text, "code") : tableText;
  const postCandidate = materializeFeishuPostMarkdownSoftBreaks(postTableText);
  // The shared fence scanner does not read a quote-prefixed marker, so a converted
  // blockquoted table cannot be closed and reopened at a cut and its two markers land in
  // different messages. Ask the question of the text the send will actually chunk, soft
  // breaks materialized, the way the comment paths ask it of their own chunker.
  const postText =
    postTableText === text ||
    postFencesSurvive(postCandidate, {
      text: postCandidate,
      limit: postLimit,
      mode: postChunkMode,
    })
      ? postCandidate
      : materializeFeishuPostMarkdownSoftBreaks(text);
  const normalizedText = useCard ? tableText : postText;

  // Core chunks raw text before channel rendering. Re-chunk after expansion
  // and keep each fenced-code chunk independently valid Markdown.
  const chunkOptions = {
    text: normalizedText,
    limit: postLimit,
    mode: postChunkMode,
  };
  const subChunks = useCard
    ? chunkFeishuCardMarkdown({ ...chunkOptions, header: params.header })
    : chunkFeishuPostMarkdown(chunkOptions);
  return { useCard, normalizedText, subChunks };
}
