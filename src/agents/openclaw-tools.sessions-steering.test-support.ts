import { vi } from "vitest";
import {
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";

export function activeRun(
  sessionKey: string,
  options: {
    sessionId?: string;
    streaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    rejects?: boolean;
  } = {},
) {
  const queueMessage = vi.fn(async (_text: string, _options?: EmbeddedAgentQueueMessageOptions) => {
    if (options.rejects) {
      throw new Error("active session ended before queued steering message was committed");
    }
  });
  setActiveEmbeddedRun(
    options.sessionId ?? "caller-active-session",
    {
      queueMessage,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => options.streaming ?? true,
        queueMessage: async (text, queueOptions, assertCurrent) => {
          assertCurrent();
          await queueMessage(text, queueOptions);
          queueOptions?.onQueueAccepted?.(true);
        },
      },
      isStreaming: () => options.streaming ?? true,
      isCompacting: () => false,
      supportsTranscriptCommitWait: true,
      sourceReplyDeliveryMode: options.sourceReplyDeliveryMode ?? "message_tool_only",
      abort: () => {},
    },
    sessionKey,
  );
  return queueMessage;
}
