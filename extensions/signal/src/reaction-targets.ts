import { registerSignalApprovalReactionTargetForDeliveredPayload } from "./approval-reactions.js";
import { registerSignalQuestionReactionTargetForDeliveredPayload } from "./question-reactions.js";

export async function registerSignalReactionTargetsForDeliveredPayload(
  params: Parameters<typeof registerSignalQuestionReactionTargetForDeliveredPayload>[0],
): Promise<void> {
  registerSignalQuestionReactionTargetForDeliveredPayload(params);
  await registerSignalApprovalReactionTargetForDeliveredPayload(params);
}
