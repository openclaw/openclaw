import { vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";

export async function seedSendSession(sessionKey: string, sessionId = "fixture-" + sessionKey) {
  await upsertSessionEntryCore(
    { agentId: parseAgentSessionKey(sessionKey)?.agentId ?? "main", sessionKey },
    { sessionId, updatedAt: 1 },
  );
}

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
    _options?.onQueueAccepted?.(true);
    _options?.onQueueSettled?.();
  });
  setActiveEmbeddedRun(
    options.sessionId ?? "caller-active-session",
    {
      queueMessage,
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
