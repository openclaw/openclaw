import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream";

type StreamContext = Parameters<StreamFn>[1];

export function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...buildCopilotDynamicHeaders({
            messages: context.messages as StreamContext["messages"],
            hasImages: hasCopilotVisionInput(context.messages as StreamContext["messages"]),
          }),
          ...(options?.headers ?? {}),
        },
      },
      applyAnthropicEphemeralCacheControlMarkers,
    );
  };
}
