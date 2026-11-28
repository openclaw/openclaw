import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import { escapeFeishuCardMarkdownText } from "./native-card.js";
import { editMessageFeishu } from "./send.js";
import type { FeishuSendResult } from "./types.js";

/**
 * Register a delivered ask_user card so terminal question states (answer,
 * cancellation, expiry, or an answer from another client) retire its controls.
 */
export function registerFeishuQuestionDelivery(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  payload: ReplyPayload;
  result: FeishuSendResult;
}): void {
  const questionId = questionGatewayRuntime.readAskUserQuestionId(params.payload);
  if (!questionId) {
    return;
  }
  const deliveryId = `feishu:${params.accountId ?? "default"}:${params.result.chatId}:${params.result.messageId}`;
  questionGatewayRuntime.registerChannelDelivery({
    questionId,
    deliveryId,
    finalize: async (statusLine: string) => {
      const promptText = params.payload.text?.trim() ?? "";
      const status = statusLine.trim();
      const content = [promptText, status]
        .filter(Boolean)
        .map(escapeFeishuCardMarkdownText)
        .join("\n\n");
      await editMessageFeishu({
        cfg: params.cfg,
        messageId: params.result.messageId,
        accountId: params.accountId,
        card: {
          schema: "2.0",
          config: { width_mode: "fill" },
          body: { elements: [{ tag: "markdown", content }] },
        },
      });
    },
  });
}
