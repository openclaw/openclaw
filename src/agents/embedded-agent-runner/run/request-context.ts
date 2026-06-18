import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelRequestContext } from "../../../llm/types.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";

export type EmbeddedRunContextKind = "default" | "heartbeat" | "cron";

export function resolveModelRequestContext(params: {
  runId?: string;
  messageChannel?: string;
  messageProvider?: string;
  bootstrapContextRunKind?: EmbeddedRunContextKind;
}): ModelRequestContext | undefined {
  const runId = normalizeOptionalString(params.runId);
  const messageChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
  const operation = resolveModelRequestContextOperation({
    runKind: params.bootstrapContextRunKind,
    hasMessageChannel: Boolean(messageChannel),
  });
  const requestContext: ModelRequestContext = {
    ...(runId ? { runId } : {}),
    ...(messageChannel ? { messageChannel } : {}),
    operation,
  };

  return Object.keys(requestContext).length > 0 ? requestContext : undefined;
}

function resolveModelRequestContextOperation(params: {
  runKind?: EmbeddedRunContextKind;
  hasMessageChannel: boolean;
}): string {
  if (params.runKind === "heartbeat") {
    return "heartbeat";
  }
  if (params.runKind === "cron") {
    return "scheduled_job";
  }
  return params.hasMessageChannel ? "message" : "manual";
}
