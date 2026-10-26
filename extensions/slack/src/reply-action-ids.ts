import type { Block, KnownBlock } from "@slack/web-api";
import { decodeSlackQuestionAction } from "./question-actions.js";

export const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
export const SLACK_REPLY_LINK_ACTION_ID = "openclaw:reply_link";
export const SLACK_SESSION_LINK_ACTION_ID = "openclaw:session_link";
export const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";

export const SLACK_BUTTON_ACTION_IDS = {
  approval: "openclaw:approval_button",
  callback: "openclaw:callback_button",
  link: SLACK_REPLY_LINK_ACTION_ID,
  question: "openclaw:question_button",
  reply: SLACK_REPLY_BUTTON_ACTION_ID,
} as const;

export const SLACK_SELECT_ACTION_IDS = {
  approval: "openclaw:approval_select",
  callback: "openclaw:callback_select",
  reply: SLACK_REPLY_SELECT_ACTION_ID,
} as const;

// Keep accepted blocks and their callback data plugin-private; string-keyed receipts are serialized.
export const SLACK_QUESTION_FINALIZATION_BLOCKS: unique symbol = Symbol(
  "slackQuestionFinalizationBlocks",
);

function createSlackActionIdMatcher(...prefixes: string[]) {
  return (actionId: string): boolean =>
    prefixes.some((prefix) => actionId === prefix || actionId.startsWith(`${prefix}:`));
}

export const isSlackQuestionActionId = createSlackActionIdMatcher(SLACK_BUTTON_ACTION_IDS.question);
export const isSlackApprovalActionId = createSlackActionIdMatcher(
  SLACK_BUTTON_ACTION_IDS.approval,
  SLACK_SELECT_ACTION_IDS.approval,
);
export const isSlackCallbackActionId = createSlackActionIdMatcher(
  SLACK_BUTTON_ACTION_IDS.callback,
  SLACK_SELECT_ACTION_IDS.callback,
);

export function isSlackQuestionActionForQuestion(
  action: { action_id?: string; value?: unknown },
  questionId: string,
): boolean {
  return Boolean(
    action.action_id &&
    isSlackQuestionActionId(action.action_id) &&
    decodeSlackQuestionAction(action.value)?.questionId === questionId,
  );
}

/** Read only question control identities from the blocks actually sent to Slack. */
export function resolveSlackQuestionActionIds(
  blocks?: readonly (Block | KnownBlock)[],
  questionId?: string,
): string[] {
  return (blocks ?? []).flatMap((block) => {
    if (block.type !== "actions") {
      return [];
    }
    const elements =
      (block as { elements?: readonly { action_id?: string; value?: unknown }[] }).elements ?? [];
    return elements.flatMap((element) =>
      element.action_id &&
      (questionId
        ? isSlackQuestionActionForQuestion(element, questionId)
        : isSlackQuestionActionId(element.action_id))
        ? [element.action_id]
        : [],
    );
  });
}
