import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function buildConfirmGateError(params: {
  errorCode: "CONFIRM_INPUT_INVALID";
  nextAction: string;
  detail: string;
}): string {
  return (
    `回覆狀態：FAILED\n` +
    `error_code=${params.errorCode}\n` +
    `next_action=${params.nextAction}\n` +
    `detail=${params.detail}`
  );
}

export function createConfirmGateTool(_api: OpenClawPluginApi) {
  return {
    name: "automation_confirm_gate",
    label: "操作確認閘門",
    description:
      "在高風險操作前要求使用者確認。會送出可互動訊息（批准/拒絕按鈕）。" +
      "適用於 git push、部署、刪除、正式環境操作等破壞性動作。",
    parameters: Type.Object({
      operation: Type.String({
        description: "操作簡述（例如：git push origin main）",
      }),
      details: Type.Optional(
        Type.String({
          description: "補充細節（例如：3 commits、修改 auth module）",
        }),
      ),
      riskLevel: Type.Union(
        [Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")],
        {
          description: "操作風險等級",
          default: "high",
        },
      ),
      timeoutMinutes: Type.Optional(
        Type.Number({ description: "逾時自動取消（分鐘），預設 30", default: 30 }),
      ),
    }),

    async execute(
      _id: string,
      params: {
        operation?: unknown;
        details?: unknown;
        riskLevel?: unknown;
        timeoutMinutes?: unknown;
      },
    ) {
      const operation = typeof params.operation === "string" ? params.operation.trim() : "";
      if (!operation) {
        throw new Error(
          buildConfirmGateError({
            errorCode: "CONFIRM_INPUT_INVALID",
            nextAction: "PROVIDE_OPERATION",
            detail: "缺少 operation 參數。",
          }),
        );
      }

      const details = typeof params.details === "string" ? params.details : undefined;
      const riskLevel = typeof params.riskLevel === "string" ? params.riskLevel : "high";
      const timeoutMinutes = typeof params.timeoutMinutes === "number" ? params.timeoutMinutes : 30;

      const taskId = generateShortId();

      const riskEmoji = riskLevel === "critical" ? "🔴" : riskLevel === "high" ? "🟠" : "🟡";
      const header = `${riskEmoji} 操作確認 (${riskLevel})`;

      let body = `**操作**: \`${operation}\``;
      if (details) {
        body += `\n**詳情**: ${details}`;
      }
      body += `\n\n⏰ ${timeoutMinutes} 分鐘內未回覆將自動取消`;

      const interactive = {
        blocks: [
          { type: "text" as const, text: `${header}\n\n${body}` },
          {
            type: "buttons" as const,
            buttons: [
              { label: "✅ 批准", value: `sc:approve:${taskId}`, style: "success" as const },
              { label: "❌ 拒絕", value: `sc:deny:${taskId}`, style: "danger" as const },
            ],
          },
        ],
      };

      return jsonResult({
        回覆狀態: "SUCCESS",
        error_code: "NONE",
        next_action: "WAIT_USER_CONFIRMATION",
        status: "awaiting_confirmation",
        taskId,
        operation,
        riskLevel,
        timeoutMinutes,
        interactive,
      });
    },
  };
}

function generateShortId(): string {
  return Math.random().toString(36).slice(2, 6);
}
