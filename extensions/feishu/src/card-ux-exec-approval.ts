import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuCardButton } from "./card-ux-shared.js";

export const FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION = "feishu.exec_approval.allow_once";
export const FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION = "feishu.exec_approval.allow_always";
export const FEISHU_EXEC_APPROVAL_DENY_ACTION = "feishu.exec_approval.deny";

export function createExecApprovalCard(params: {
  approvalId: string;
  command: string;
  cwd?: string;
  host?: string;
  nodeId?: string;
  expiresAtMs: number;
}): Record<string, unknown> {
  const approvalSlug = params.approvalId.slice(0, 8);
  const bodyLines: string[] = [
    `**Approval ID:** \`${approvalSlug}\``,
    `**Command:** \`${params.command}\``,
  ];
  if (params.cwd) {
    bodyLines.push(`**CWD:** \`${params.cwd}\``);
  }
  if (params.host) {
    bodyLines.push(`**Host:** ${params.host}`);
  }
  if (params.nodeId) {
    bodyLines.push(`**Node:** \`${params.nodeId}\``);
  }

  const metadata = { approvalId: params.approvalId };

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Exec Approval Required",
      },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: bodyLines.join("\n"),
        },
        {
          tag: "action",
          actions: [
            buildFeishuCardButton({
              label: "Allow Once",
              type: "primary",
              value: createFeishuCardInteractionEnvelope({
                k: "button",
                a: FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION,
                m: metadata,
              }),
            }),
            buildFeishuCardButton({
              label: "Allow Always",
              value: createFeishuCardInteractionEnvelope({
                k: "button",
                a: FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
                m: metadata,
              }),
            }),
            buildFeishuCardButton({
              label: "Deny",
              type: "danger",
              value: createFeishuCardInteractionEnvelope({
                k: "button",
                a: FEISHU_EXEC_APPROVAL_DENY_ACTION,
                m: metadata,
              }),
            }),
          ],
        },
      ],
    },
  };
}

export function createExecApprovalResolvedCard(params: {
  approvalId: string;
  decision: string;
  resolvedBy?: string;
}): Record<string, unknown> {
  const approvalSlug = params.approvalId.slice(0, 8);
  const decisionLabel =
    params.decision === "allow-once"
      ? "Allowed (once)"
      : params.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const template = params.decision === "deny" ? "red" : "green";
  const resolvedByText = params.resolvedBy ? ` by ${params.resolvedBy}` : "";

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: `Exec Approval — ${decisionLabel}`,
      },
      template,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**Approval ID:** \`${approvalSlug}\`\n**Decision:** ${decisionLabel}${resolvedByText}`,
        },
      ],
    },
  };
}
