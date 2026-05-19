import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function createConfirmGateTool(api: OpenClawPluginApi) {
  return {
    name: "automation_confirm_gate",
    label: "Confirm Gate",
    description:
      "Request user confirmation before executing a high-risk operation. " +
      "Sends an interactive message with approve/deny buttons to the user's channel. " +
      "Use this for: git push, deploy, delete, production operations, or any destructive action.",
    parameters: Type.Object({
      operation: Type.String({
        description: "Short description of the operation (e.g., 'git push origin main')",
      }),
      details: Type.Optional(
        Type.String({
          description: "Additional details about what will happen (e.g., '3 commits, modifies auth module')",
        }),
      ),
      riskLevel: Type.Union([Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")], {
        description: "Risk level of the operation",
        default: "high",
      }),
      timeoutMinutes: Type.Optional(
        Type.Number({ description: "Auto-cancel after N minutes if no response. Default: 30", default: 30 }),
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
        throw new Error("operation is required");
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
              { label: "✅ 批准", value: `approve:${taskId}`, style: "success" as const },
              { label: "❌ 拒絕", value: `deny:${taskId}`, style: "danger" as const },
            ],
          },
        ],
      };

      return [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "awaiting_confirmation",
            taskId,
            operation,
            riskLevel,
            timeoutMinutes,
            interactive,
          }, null, 2),
        },
      ];
    },
  };
}

function generateShortId(): string {
  return Math.random().toString(36).slice(2, 6);
}
