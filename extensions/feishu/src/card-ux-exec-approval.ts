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
  chatType?: "p2p" | "group";
}): Record<string, unknown> {
  const approvalSlug = params.approvalId.slice(0, 8);
  const bodyLines: string[] = [
    `**审批 ID：** \`${approvalSlug}\``,
    `**命令：** \`${params.command}\``,
  ];
  if (params.cwd) {
    bodyLines.push(`**工作目录：** \`${params.cwd}\``);
  }
  if (params.host) {
    bodyLines.push(`**主机：** ${params.host}`);
  }
  if (params.nodeId) {
    bodyLines.push(`**节点：** \`${params.nodeId}\``);
  }

  const metadata: Record<string, string> = { approvalId: params.approvalId };
  if (params.command) {
    metadata.command = params.command;
  }
  if (params.cwd) {
    metadata.cwd = params.cwd;
  }
  // Exec approval context omits u (user) and h (chat) — any configured
  // approver may click from any surface (DM or channel). Include expiry
  // and chat type so callbacks enforce TTL and route correctly.
  const context: { e: number; t?: "p2p" | "group" } = {
    e: params.expiresAtMs,
    ...(params.chatType ? { t: params.chatType } : {}),
  };

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "命令执行审批",
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
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "default",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                buildFeishuCardButton({
                  label: "允许一次",
                  type: "primary",
                  value: createFeishuCardInteractionEnvelope({
                    k: "button",
                    a: FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION,
                    m: metadata,
                    c: context,
                  }),
                }),
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                buildFeishuCardButton({
                  label: "始终允许",
                  value: createFeishuCardInteractionEnvelope({
                    k: "button",
                    a: FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
                    m: metadata,
                    c: context,
                  }),
                }),
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                buildFeishuCardButton({
                  label: "拒绝",
                  type: "danger",
                  value: createFeishuCardInteractionEnvelope({
                    k: "button",
                    a: FEISHU_EXEC_APPROVAL_DENY_ACTION,
                    m: metadata,
                    c: context,
                  }),
                }),
              ],
            },
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
  command?: string;
  cwd?: string;
}): Record<string, unknown> {
  const approvalSlug = params.approvalId.slice(0, 8);
  const decisionLabel =
    params.decision === "allow-once"
      ? "已允许（一次）"
      : params.decision === "allow-always"
        ? "已允许（始终）"
        : "已拒绝";
  const template = params.decision === "deny" ? "red" : "green";
  const bodyLines: string[] = [`**审批 ID：** \`${approvalSlug}\``];
  if (params.command) {
    bodyLines.push(`**命令：** \`${params.command}\``);
  }
  if (params.cwd) {
    bodyLines.push(`**工作目录：** \`${params.cwd}\``);
  }
  bodyLines.push(`**结果：** ${decisionLabel}`);
  if (params.resolvedBy) {
    bodyLines.push(`**操作人：** <at id="${params.resolvedBy}"></at>`);
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: `命令执行审批 — ${decisionLabel}`,
      },
      template,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: bodyLines.join("\n"),
        },
      ],
    },
  };
}
