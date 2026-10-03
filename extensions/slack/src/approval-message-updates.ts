import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { decodeSlackApprovalAction, type SlackApprovalAction } from "./approval-actions.js";
import { isSlackApprovalActionId } from "./reply-action-ids.js";

const updates = new KeyedAsyncQueue();

export function runSlackApprovalMessageUpdate<T>(
  target: { accountId: string; channelId: string; messageTs: string },
  update: () => Promise<T>,
): Promise<T> {
  return updates.enqueue(
    JSON.stringify([target.accountId, target.channelId, target.messageTs]),
    update,
  );
}

export function hasSlackApprovalControl(
  blocks: unknown[] | undefined,
  approval: SlackApprovalAction,
): boolean {
  return (
    blocks?.some((rawBlock) => {
      const block = asOptionalRecord(rawBlock);
      if (block?.type !== "actions" || !Array.isArray(block.elements)) {
        return false;
      }
      return block.elements.some((rawElement: unknown) => {
        const element = asOptionalRecord(rawElement);
        if (
          element?.type !== "button" ||
          typeof element.action_id !== "string" ||
          !isSlackApprovalActionId(element.action_id)
        ) {
          return false;
        }
        const current = decodeSlackApprovalAction(element.value);
        return (
          current?.approvalId === approval.approvalId &&
          current.approvalKind === approval.approvalKind &&
          current.decision === approval.decision
        );
      });
    }) ?? false
  );
}
