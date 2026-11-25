import type { SectionBlock } from "@slack/types";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";

/** Native plain-text blocks plus a non-parsing accessibility fallback. */
export function buildSlackLiteralText(text: string) {
  const blocks: SectionBlock[] = chunkTextForOutbound(text, SLACK_SECTION_TEXT_MAX, {
    preserveWhitespace: true,
  }).map((chunk) => ({
    type: "section",
    text: { type: "plain_text", text: chunk, emoji: false },
  }));
  return {
    text: escapeSlackMrkdwn(text),
    blocks,
    mrkdwn: false,
    parse: "none" as const,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  };
}
