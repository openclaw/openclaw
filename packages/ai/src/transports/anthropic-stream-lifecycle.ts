import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import type { AssistantMessageEvent, Context, Model } from "@openclaw/llm-core";
import type { AnthropicOptions } from "../provider-options.js";
import { usesClaudeStreamingRefusalContract } from "../providers/anthropic-model-contract.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import {
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
  type AnthropicCompactionBlock,
} from "./anthropic-compaction-replay.js";
import { buildAnthropicRequest, prepareAnthropicRequest } from "./anthropic-messages.js";
import { consumeAnthropicStream } from "./anthropic-stream-reducer.js";
import { createAssistantOutput } from "./assistant-output.js";
import {
  failTransportStream,
  finalizeTransportStream,
  notifyProviderHttpResponse,
  type WritableTransportStream,
} from "./transport-stream-shared.js";

type LifecycleOptions = AnthropicOptions & { authProfileId?: string };

/** Entry points retain their SDK/fetch adapters; request and terminal ownership is shared. */
export async function runAnthropicStreamLifecycle(params: {
  model: Model<"anthropic-messages">;
  stream: WritableTransportStream;
  options?: LifecycleOptions;
  profile: "provider" | "transport";
  prepare: () => {
    context: Context;
    options: LifecycleOptions | undefined;
    isOAuthToken: boolean;
    serverSideFallback: boolean;
    directApiKeyBetaHeader?: string;
    claudeCodeVersion?: string;
    request: (
      body: MessageCreateParamsStreaming,
      headers: Record<string, string> | undefined,
    ) => Promise<{ response: Response; events: AsyncIterable<object> | Iterable<object> }>;
    checkResponse?: (response: Response) => Promise<void>;
  };
}): Promise<void> {
  const { model, stream, options, profile } = params;
  const output = createAssistantOutput(model, "anthropic-messages");
  // Classifier refusals can invalidate partial output until the terminal stop reason is known.
  const refusalBuffer = usesClaudeStreamingRefusalContract(model)
    ? createDeferredEventBuffer<AssistantMessageEvent>(stream)
    : undefined;
  let replayedCompaction: AnthropicCompactionBlock | undefined;
  try {
    const prepared = params.prepare();
    const built = await buildAnthropicRequest(
      model,
      prepared.context,
      prepared.options,
      profile,
      prepared.isOAuthToken,
      prepared.serverSideFallback,
      prepared.claudeCodeVersion,
    );
    replayedCompaction = built.replayedCompaction;
    const { params: body, headers } = await prepareAnthropicRequest(
      built.params,
      model,
      prepared.options,
      prepared.directApiKeyBetaHeader,
    );
    const { response, events } = await prepared.request({ ...body, stream: true }, headers);
    await notifyProviderHttpResponse({ options: prepared.options, response, model });
    await prepared.checkResponse?.(response);
    await consumeAnthropicStream({
      events,
      model,
      options: prepared.options ?? {},
      output,
      stream,
      refusalBuffer,
      isOAuthToken: prepared.isOAuthToken,
      toolProjection: built.toolProjection,
      profile,
    });
    finalizeTransportStream({ stream, output });
  } catch (error) {
    failTransportStream({
      stream,
      output,
      signal: options?.signal,
      error,
      cleanup: () => {
        refusalBuffer?.discard();
        output.content = refusalBuffer
          ? []
          : output.content.filter((block) => block.type !== "toolCall");
        if (
          replayedCompaction &&
          isAnthropicReplayRejection(profile === "provider" ? error : output)
        ) {
          suppressAnthropicCompaction(output, model, options, replayedCompaction);
        }
      },
    });
  }
}
