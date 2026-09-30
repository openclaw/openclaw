import type { Block, KnownBlock } from "@slack/web-api";

export const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
export const SLACK_REPLY_LINK_ACTION_ID = "openclaw:reply_link";
export const SLACK_SESSION_LINK_ACTION_ID = "openclaw:session_link";
export const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
const SLACK_CALLBACK_BUTTON_ACTION_ID = "openclaw:callback_button";
const SLACK_CALLBACK_SELECT_ACTION_ID = "openclaw:callback_select";
const SLACK_APPROVAL_BUTTON_ACTION_ID = "openclaw:approval_button";
const SLACK_APPROVAL_SELECT_ACTION_ID = "openclaw:approval_select";
const SLACK_QUESTION_BUTTON_ACTION_ID = "openclaw:question_button";

export const SLACK_BUTTON_ACTION_IDS = {
  approval: SLACK_APPROVAL_BUTTON_ACTION_ID,
  callback: SLACK_CALLBACK_BUTTON_ACTION_ID,
  link: SLACK_REPLY_LINK_ACTION_ID,
  question: SLACK_QUESTION_BUTTON_ACTION_ID,
  reply: SLACK_REPLY_BUTTON_ACTION_ID,
} as const;

export const SLACK_SELECT_ACTION_IDS = {
  approval: SLACK_APPROVAL_SELECT_ACTION_ID,
  callback: SLACK_CALLBACK_SELECT_ACTION_ID,
  reply: SLACK_REPLY_SELECT_ACTION_ID,
} as const;

// Keep accepted display blocks plugin-private; string-keyed receipts are serialized.
export const SLACK_QUESTION_FINALIZATION_BLOCKS: unique symbol = Symbol(
  "slackQuestionFinalizationBlocks",
);

export function isSlackQuestionActionId(actionId: string): boolean {
  return (
    actionId === SLACK_QUESTION_BUTTON_ACTION_ID ||
    actionId.startsWith(`${SLACK_QUESTION_BUTTON_ACTION_ID}:`)
  );
}

/** Read only question control identities from the blocks actually sent to Slack. */
export function resolveSlackQuestionActionIds(blocks?: readonly (Block | KnownBlock)[]): string[] {
  return (blocks ?? []).flatMap((block) => {
    if (block.type !== "actions") {
      return [];
    }
    const elements = (block as { elements?: readonly { action_id?: string }[] }).elements ?? [];
    return elements.flatMap(({ action_id }) =>
      action_id && isSlackQuestionActionId(action_id) ? [action_id] : [],
    );
  });
}

export function isSlackApprovalActionId(actionId: string): boolean {
  return (
    actionId === SLACK_APPROVAL_BUTTON_ACTION_ID ||
    actionId === SLACK_APPROVAL_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_APPROVAL_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_APPROVAL_SELECT_ACTION_ID}:`)
  );
}

export function isSlackCallbackActionId(actionId: string): boolean {
  return (
    actionId === SLACK_CALLBACK_BUTTON_ACTION_ID ||
    actionId === SLACK_CALLBACK_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_CALLBACK_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_CALLBACK_SELECT_ACTION_ID}:`)
  );
}
