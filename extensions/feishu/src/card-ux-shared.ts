import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";

export function buildFeishuActionCard(params: {
  title: string;
  template: string;
  content: string;
  actions: ReturnType<typeof buildFeishuCardButton>[];
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: params.title },
      template: params.template,
    },
    body: {
      elements: [
        { tag: "markdown", content: params.content },
        { tag: "action", actions: params.actions },
      ],
    },
  };
}

export function buildFeishuCardButton(params: {
  label: string;
  value: FeishuCardInteractionEnvelope;
  type?: "default" | "primary" | "danger";
}) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.label,
    },
    type: params.type ?? "default",
    value: params.value,
  };
}

export function buildFeishuCardInteractionContext(params: {
  operatorOpenId: string;
  chatId?: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
}) {
  return {
    u: params.operatorOpenId,
    ...(params.chatId ? { h: params.chatId } : {}),
    ...(params.sessionKey ? { s: params.sessionKey } : {}),
    e: params.expiresAt,
    ...(params.chatType ? { t: params.chatType } : {}),
  };
}
