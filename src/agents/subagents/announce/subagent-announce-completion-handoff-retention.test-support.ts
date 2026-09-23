import {
  buildAnnounceIdempotencyKey,
  buildRequesterSettleAnnounceId,
} from "../../announce-idempotency.js";
import {
  releaseCompletionHandoffKey,
  resolvePendingGatewayCompletionHandoff,
  shouldPreferOriginalCompletionHandoff,
} from "./subagent-announce-completion-handoff-retention.js";

export function retainRequesterSettleCompletionHandoffForTest(params: {
  requesterAgentId?: string;
  requesterSessionKey: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
}) {
  const directIdempotencyKey = buildAnnounceIdempotencyKey(buildRequesterSettleAnnounceId(params));
  resolvePendingGatewayCompletionHandoff({
    parentOnly: false,
    expectsCompletionMessage: true,
    directIdempotencyKey,
  });
  return {
    isRetained: () => shouldPreferOriginalCompletionHandoff({ directIdempotencyKey }),
    release: () => releaseCompletionHandoffKey(directIdempotencyKey),
  };
}
