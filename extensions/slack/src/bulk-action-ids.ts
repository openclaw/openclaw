// Slack plugin module implements bulk action id behavior.
import type { Block, KnownBlock } from "@slack/web-api";

/** OpenClaw-owned bulk-row block marker. Producers must set this block_id prefix. */
export const SLACK_BULK_ACTIONS_BLOCK_ID_PREFIX = "openclaw:bulk:";

export const SLACK_BULK_SELECT_ALL_ACTION_ID = "openclaw:bulk:select_all";
export const SLACK_BULK_DESELECT_ALL_ACTION_ID = "openclaw:bulk:deselect_all";

const OPENCLAW_SLACK_BULK_ACTION_IDS = Object.freeze([
  SLACK_BULK_SELECT_ALL_ACTION_ID,
  SLACK_BULK_DESELECT_ALL_ACTION_ID,
] as const);

type SlackBulkActionElement = {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string };
  value?: string;
};

type SlackBulkActionsBlock = {
  type: "actions";
  block_id: string;
  elements: SlackBulkActionElement[];
};

export function isOpenClawBulkActionId(actionId: string): boolean {
  return (OPENCLAW_SLACK_BULK_ACTION_IDS as readonly string[]).includes(actionId);
}

export function isOpenClawBulkActionsBlock(block: {
  type?: string;
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
}): boolean {
  if (block.type !== "actions" || !Array.isArray(block.elements) || block.elements.length === 0) {
    return false;
  }
  const blockId = typeof block.block_id === "string" ? block.block_id : "";
  if (!blockId.startsWith(SLACK_BULK_ACTIONS_BLOCK_ID_PREFIX)) {
    return false;
  }
  return block.elements.every(
    (element) => typeof element.action_id === "string" && isOpenClawBulkActionId(element.action_id),
  );
}

/** Classify OpenClaw-owned bulk rows for confirmation cleanup. */
export function isSlackBulkActionsBlock(block: {
  type?: string;
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
}): boolean {
  return isOpenClawBulkActionsBlock(block);
}

export function buildOpenClawBulkActionsBlock(params?: {
  blockIdSuffix?: string;
  selectAllValue?: string;
  deselectAllValue?: string;
}): SlackBulkActionsBlock {
  const suffix = params?.blockIdSuffix?.trim() || "actions";
  return {
    type: "actions",
    block_id: `${SLACK_BULK_ACTIONS_BLOCK_ID_PREFIX}${suffix}`,
    elements: [
      {
        type: "button",
        action_id: SLACK_BULK_SELECT_ALL_ACTION_ID,
        text: { type: "plain_text", text: "Select all" },
        ...(params?.selectAllValue ? { value: params.selectAllValue } : {}),
      },
      {
        type: "button",
        action_id: SLACK_BULK_DESELECT_ALL_ACTION_ID,
        text: { type: "plain_text", text: "Deselect all" },
        ...(params?.deselectAllValue ? { value: params.deselectAllValue } : {}),
      },
    ],
  };
}

export type { SlackBulkActionsBlock };

export function asSlackBlock(block: SlackBulkActionsBlock): Block | KnownBlock {
  return block as Block | KnownBlock;
}
