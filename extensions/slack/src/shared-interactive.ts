import type { Block, KnownBlock } from "@slack/web-api";
import type { InteractiveReply } from "../../../src/interactive/payload.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_PLAIN_TEXT_MAX = 75;
const SLACK_OPTION_VALUE_MAX = 75;

export type SlackBlock = Block | KnownBlock;

function buildSlackReplyChoiceToken(value: string, index: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return truncateSlackText(`reply_${index}_${slug || "choice"}`, SLACK_OPTION_VALUE_MAX);
}

export function buildSlackInteractiveBlocks(interactive?: InteractiveReply): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  let buttonIndex = 0;
  let selectIndex = 0;
  for (const block of interactive?.blocks ?? []) {
    if (block.type === "text") {
      const trimmed = block.text.trim();
      if (!trimmed) {
        continue;
      }
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateSlackText(trimmed, SLACK_SECTION_TEXT_MAX),
        },
      });
      continue;
    }
    if (block.type === "buttons") {
      if (block.buttons.length === 0) {
        continue;
      }
      blocks.push({
        type: "actions",
        block_id: `openclaw_reply_buttons_${++buttonIndex}`,
        elements: block.buttons.map((button, choiceIndex) => ({
          type: "button",
          action_id: SLACK_REPLY_BUTTON_ACTION_ID,
          text: {
            type: "plain_text",
            text: truncateSlackText(button.label, SLACK_PLAIN_TEXT_MAX),
            emoji: true,
          },
          value: buildSlackReplyChoiceToken(button.value, choiceIndex + 1),
        })),
      });
      continue;
    }
    if (block.options.length === 0) {
      continue;
    }
    blocks.push({
      type: "actions",
      block_id: `openclaw_reply_select_${++selectIndex}`,
      elements: [
        {
          type: "static_select",
          action_id: SLACK_REPLY_SELECT_ACTION_ID,
          placeholder: {
            type: "plain_text",
            text: truncateSlackText(
              block.placeholder?.trim() || "Choose an option",
              SLACK_PLAIN_TEXT_MAX,
            ),
            emoji: true,
          },
          options: block.options.map((option, choiceIndex) => ({
            text: {
              type: "plain_text",
              text: truncateSlackText(option.label, SLACK_PLAIN_TEXT_MAX),
              emoji: true,
            },
            value: buildSlackReplyChoiceToken(option.value, choiceIndex + 1),
          })),
        },
      ],
    });
  }
  return blocks;
}
