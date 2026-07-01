// Slack plugin module implements threaded delivery confirmation.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function assertSlackThreadDeliveryResult(params: {
  result: {
    confirmedThreadTs?: string;
    messageId?: string;
  };
  to: string;
  threadTs?: string;
}) {
  if (!params.threadTs) {
    return;
  }
  const deliveredThreadTs = normalizeOptionalString(params.result.confirmedThreadTs);
  if (deliveredThreadTs === params.threadTs) {
    return;
  }
  const deliveredMessageId = normalizeOptionalString(params.result.messageId);
  const suffix = deliveredThreadTs
    ? `; delivered thread ${deliveredThreadTs}`
    : deliveredMessageId
      ? `; delivered message ${deliveredMessageId}`
      : "";
  throw new Error(
    `Slack delivery did not confirm thread ${params.threadTs} for ${params.to}${suffix}`,
  );
}
