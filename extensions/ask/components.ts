import type { DiscordComponentMessageSpec } from "openclaw/plugin-sdk/discord-interactions";
import {
  ASK_GRILL_STEP_COUNT,
  formatAskGrillQuestion,
  isAskGrillSession,
  sanitizeDiscordDisplayText,
} from "./grill.js";
import type { AskSession } from "./types.js";

export function buildAskDiscordComponents(session: AskSession): DiscordComponentMessageSpec {
  const callbackData = `ask:${session.askId}`;
  const allowedUsers = session.allowedUsers.length > 0 ? session.allowedUsers : undefined;
  const text = isAskGrillSession(session)
    ? formatAskGrillQuestion(session)
    : [
        `**/ask** ${sanitizeDiscordDisplayText(session.questionText, 500)}`,
        "-# 回答は記録のみです。実装・送信・設定変更には別GOが必要です。",
      ].join("\n");

  if (session.uiType === "modal") {
    return {
      reusable: false,
      text,
      modal: {
        title: isAskGrillSession(session) ? "Answer /ask grill" : "Answer /ask",
        callbackData,
        triggerLabel: isAskGrillSession(session) ? "この質問に答える" : "回答する",
        triggerStyle: "primary",
        allowedUsers,
        fields: [
          {
            type: "text",
            name: "answer",
            label: isAskGrillSession(session)
              ? `回答 ${((session.grill?.currentStepIndex ?? 0) + 1).toString()}/${ASK_GRILL_STEP_COUNT.toString()}`
              : "回答・理由・補足",
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
    `mode: ${session.mode}`,
    `ui_type: ${session.uiType}`,
    `expires_at: ${expires}`,
    "policy: log_only / requires_second_go=true / action_scope=answer_capture_only",
  ].join("\n");
}
