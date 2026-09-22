import { encodeSlackApprovalAction, type SlackApprovalAction } from "../../approval-actions.js";

export function singleButtonBlocks(blockId: string, actionId: string) {
  return [
    {
      type: "actions",
      block_id: blockId,
      elements: [{ type: "button", action_id: actionId }],
    },
  ];
}

export function approvalButtonBlocks(
  approvalId: string,
  approvalKind: SlackApprovalAction["approvalKind"],
  decision: SlackApprovalAction["decision"],
) {
  return [
    {
      type: "actions",
      block_id: "exec_actions",
      elements: [
        {
          type: "button",
          action_id: "openclaw:approval_button:1:1",
          value: encodeSlackApprovalAction({
            type: "approval",
            approvalId,
            approvalKind,
            decision,
          }),
        },
      ],
    },
  ];
}

export function approvalContextOptions(pluginApprover: string, execApprover: string) {
  return {
    cfg: {
      channels: {
        slack: {
          accounts: {
            default: {
              allowFrom: [pluginApprover],
              execApprovals: {
                enabled: true,
                approvers: [execApprover],
                target: "both",
              },
            },
          },
        },
      },
    },
  };
}
