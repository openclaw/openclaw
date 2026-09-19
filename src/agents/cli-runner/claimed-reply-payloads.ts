import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { persistClaimedCliAssistantReply } from "./cli-run-transcript.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * Records the reply a before_agent_reply claim owns as this turn's transcript answer and
 * returns the payloads with the writer's receipt attached. Delivery suppresses its own
 * transcript mirror only when that ownership metadata is present, so dropping the receipt
 * would let a claimed answer land twice in durable history (#149985).
 */
export async function resolveClaimedReplyPayloads(
  payloads: ReplyPayload[],
  runParams: RunCliAgentParams,
  text: string | undefined,
): Promise<ReplyPayload[]> {
  const receipt = await persistClaimedCliAssistantReply({ runParams, text });
  if (receipt?.owned !== true) {
    return payloads;
  }
  return payloads.map((payload) =>
    setReplyPayloadMetadata(payload, {
      assistantTranscriptOwned: true,
      ...(receipt.idempotencyKey
        ? { assistantTranscriptIdempotencyKey: receipt.idempotencyKey }
        : {}),
    }),
  );
}
