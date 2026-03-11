import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { requestApproval, notifyOwner } from "./approval-gate.js";
import { textResult } from "./common.js";

export function createApprovalTools(_api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "request_approval",
      label: "Request Telegram Approval",
      description:
        "Send an approval request to the owner via Telegram with Approve/Reject buttons. Blocks up to 5 minutes waiting for a response.",
      parameters: Type.Object({
        type: Type.Union([Type.Literal("post"), Type.Literal("campaign"), Type.Literal("ad_set")]),
        summary: Type.String({ description: "Brief summary of what needs approval" }),
        details: Type.String({ description: "Full details of the item" }),
        preview_url: Type.Optional(Type.String({ description: "Image URL to send as preview" })),
      }),
      async execute(
        _id: string,
        params: {
          type: "post" | "campaign" | "ad_set";
          summary: string;
          details: string;
          preview_url?: string;
        },
      ) {
        const result = await requestApproval(params);
        if (result.approved) {
          return textResult(`✅ APPROVED by ${result.decided_by} at ${result.decided_at}`);
        }
        return textResult(`❌ REJECTED by ${result.decided_by} at ${result.decided_at}`);
      },
    },
    {
      name: "notify_owner",
      label: "Send Telegram Notification",
      description: "Send a notification message to the owner via Telegram (no approval needed).",
      parameters: Type.Object({
        message: Type.String({ description: "Markdown-formatted message to send" }),
      }),
      async execute(_id: string, params: { message: string }) {
        await notifyOwner(params.message);
        return textResult("Notification sent to owner via Telegram.");
      },
    },
  ];
}
