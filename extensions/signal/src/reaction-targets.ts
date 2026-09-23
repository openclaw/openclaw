import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { registerSignalApprovalReactionTargetForDeliveredPayload } from "./approval-reactions.js";
import { registerSignalQuestionReactionTargetForDeliveredPayload } from "./question-reactions.js";

export async function registerSignalReactionTargetsForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: { channel: string; to: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): Promise<void> {
  registerSignalQuestionReactionTargetForDeliveredPayload(params);
  await registerSignalApprovalReactionTargetForDeliveredPayload(params);
}
