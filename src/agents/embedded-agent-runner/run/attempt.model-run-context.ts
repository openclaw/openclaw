import type { ModelRequestRunContext, StreamFn } from "../../../llm/types.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";

type EmbeddedModelRequestRunContextParams = {
  runId: string;
  messageChannel?: string;
  messageProvider?: string;
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  trigger?: string;
};

export function resolveEmbeddedModelRequestRunKind(
  params: Pick<EmbeddedModelRequestRunContextParams, "bootstrapContextRunKind" | "trigger">,
): ModelRequestRunContext["runKind"] {
  if (params.bootstrapContextRunKind === "heartbeat" || params.trigger === "heartbeat") {
    return "heartbeat";
  }
  if (params.bootstrapContextRunKind === "cron" || params.trigger === "cron") {
    return "cron";
  }
  return "message";
}

export function buildEmbeddedModelRequestRunContext(
  params: EmbeddedModelRequestRunContextParams,
): ModelRequestRunContext {
  const messageChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
  return {
    runId: params.runId,
    ...(messageChannel ? { messageChannel } : {}),
    runKind: resolveEmbeddedModelRequestRunKind(params),
  };
}

export function wrapStreamFnWithModelRequestRunContext(
  streamFn: StreamFn,
  runContext: ModelRequestRunContext,
): StreamFn {
  return (model, context, options) =>
    streamFn(
      model,
      {
        ...context,
        runContext: {
          ...context.runContext,
          ...runContext,
        },
      },
      options,
    );
}
