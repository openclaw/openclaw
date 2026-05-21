import type { DiscordComponentMessageSpec } from "openclaw/plugin-sdk/discord";
import type { AskSession } from "./types.js";

export function buildAskDiscordComponents(session: AskSession): DiscordComponentMessageSpec {
  const callbackData = `ask:${session.askId}`;
  const allowedUsers = session.allowedUsers.length > 0 ? session.allowedUsers : undefined;
  const text = [
    `**/ask** ${session.questionText}`,
    "-# 回答は記録のみです。実装・送信・設定変更には別GOが必要です。",
  ].join("\n");

  if (session.uiType === "modal") {
    return {
      reusable: false,
      text,
      modal: {
        title: "Answer /ask",
        callbackData,
        triggerLabel: "回答する",
        triggerStyle: "primary",
        allowedUsers,
        fields: [
          {
            type: "text",
            name: "answer",
            label: "回答・理由・補足",
            required: true,
            style: "paragraph",
            maxLength: 1000,
          },
        ],
      },
    };
  }

  if (session.uiType === "select") {
    return {
      reusable: false,
      text,
      blocks: [
        {
          type: "actions",
          select: {
            type: "string",
            callbackData,
            placeholder: "選択してください",
            minValues: 1,
            maxValues: 1,
            allowedUsers,
            options: session.options.map((option) => ({
              label: option.label,
              value: option.value,
            })),
          },
        },
      ],
    };
  }

  return {
    reusable: false,
    text,
    blocks: [
      {
        type: "actions",
        buttons: session.options.slice(0, 5).map((option, index) => ({
          label: option.label,
          style: index === 0 ? "primary" : "secondary",
          callbackData: `${callbackData}:${option.value}`,
          allowedUsers,
        })),
      },
    ],
  };
}

export function formatAskCommandFallback(session: AskSession): string {
  const expires = new Date(session.expiresAt).toISOString();
  return [
    `ask_id: ${session.askId}`,
    `ui_type: ${session.uiType}`,
    `expires_at: ${expires}`,
    "policy: log_only / requires_second_go=true / action_scope=answer_capture_only",
  ].join("\n");
}
