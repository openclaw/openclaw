import type { Block, KnownBlock } from "@slack/web-api";
import { reduceInteractiveReply } from "../../../src/channels/plugins/outbound/interactive.js";
import type { InteractiveReply } from "../../../src/interactive/payload.js";
import { truncateSlackText } from "./truncate.js";

export const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
export const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_PLAIN_TEXT_MAX = 75;

export type SlackBlock = Block | KnownBlock;

export function buildSlackInteractiveBlocks(interactive?: InteractiveReply): SlackBlock[] {
  const initialState = {
    blocks: [] as SlackBlock[],
    buttonIndex: 0,
    selectIndex: 0,
  };
  return reduceInteractiveReply(interactive, initialState, (state, block) => {
    if (block.type === "text") {
      const trimmed = block.text.trim();
      if (!trimmed) {
        return state;
      }
      state.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateSlackText(trimmed, SLACK_SECTION_TEXT_MAX),
        },
      });
      return state;
    }
    if (block.type === "buttons") {
      if (block.buttons.length === 0) {
        return state;
      }
      state.blocks.push({
        type: "actions",
        block_id: `openclaw_reply_buttons_${++state.buttonIndex}`,
        elements: block.buttons.map((button, choiceIndex) => ({
          type: "button",
          action_id: SLACK_REPLY_BUTTON_ACTION_ID,
          text: {
            type: "plain_text",
            text: truncateSlackText(button.label, SLACK_PLAIN_TEXT_MAX),
            emoji: true,
          },
          value: button.value,
        })),
      });
      return state;
    }
    if (block.options.length === 0) {
      return state;
    }
    state.blocks.push({
      type: "actions",
      block_id: `openclaw_reply_select_${++state.selectIndex}`,
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
            value: option.value,
          })),
        },
      ],
    });
    return state;
  }).blocks;
}
