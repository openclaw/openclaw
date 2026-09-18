import {
  embeddedAgentLog,
  emitAgentEvent,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";

export async function commitAgentsApiAssistant(
  params: AgentHarnessAttemptParamsV2,
  sessionTarget: SessionTranscriptTargetParams,
  remoteSessionId: string,
  rootTurnId: string,
  text: string,
  usage: AssistantMessage["usage"],
  assertCurrent: () => void,
): Promise<AssistantMessage> {
  const assistant: AssistantMessage & { idempotencyKey: string } = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: params.model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
    idempotencyKey: `agentsapi:${remoteSessionId}:${rootTurnId}`,
  };
  const append = await appendSessionTranscriptMessageByIdentityStrict({
    ...sessionTarget,
    config: params.config,
    message: assistant,
    prepareMessageAfterIdempotencyCheck: (message) => {
      assertCurrent();
      return message;
    },
  });
  assertCurrent();
  if (append.kind !== "result") {
    throw new Error("Agents API assistant transcript append was refused");
  }
  return append.result.message;
}

export function createAgentsApiSnapshotEmitter(params: AgentHarnessAttemptParamsV2) {
  let visibleAssistantItemId: string | undefined;
  return (itemId: string, text: string, delta = "") => {
    const replace = visibleAssistantItemId !== itemId;
    visibleAssistantItemId = itemId;
    // Steering can supersede a completed native turn before the session settles.
    // Hold append-only consumers until authoritative items select the final reply.
    emitAgentsApiEvent(params, {
      stream: "assistant",
      data: {
        itemId,
        text,
        delta: replace ? "" : delta,
        replaceable: true,
        ...(replace ? { replace: true } : {}),
      },
    });
  };
}

export function selectAgentsApiReplyText(items: AgentsApiItem[]): string {
  const completedMessages = items.filter(
    (item) => item.type === "message" && item.role === "assistant" && item.status === "completed",
  );
  const finalItems = completedMessages.filter((item) => item.phase === "final_answer");
  const visibleItems = finalItems.length
    ? finalItems
    : completedMessages.filter((item) => item.phase !== "commentary");
  return visibleItems
    .map(
      (item) =>
        item.content
          ?.filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join("") ?? "",
    )
    .join("\n");
}

export function createAgentsApiUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function updateAgentsApiUsage(
  usage: AssistantMessage["usage"],
  nativeUsage: NonNullable<AgentsApiEvent["turn"]>["usage"],
): AssistantMessage["usage"] {
  if (!nativeUsage) {
    return usage;
  }
  const updated = {
    ...usage,
    input: nativeUsage.input_tokens - (nativeUsage.input_tokens_details?.cached_tokens ?? 0),
    output: nativeUsage.output_tokens,
    cacheRead: nativeUsage.input_tokens_details?.cached_tokens ?? 0,
    totalTokens: nativeUsage.input_tokens + nativeUsage.output_tokens,
  };
  return updated;
}

export function emitAgentsApiEvent(
  params: AgentHarnessAttemptParamsV2,
  event: Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0],
): void {
  try {
    emitAgentEvent({ runId: params.runId, sessionKey: params.sessionKey, ...event });
  } catch (error) {
    embeddedAgentLog.debug("Agents API global event handler failed", { error });
  }
  try {
    void Promise.resolve(params.onAgentEvent?.(event)).catch((error: unknown) => {
      embeddedAgentLog.debug("Agents API event handler rejected", { error });
    });
  } catch (error) {
    embeddedAgentLog.debug("Agents API event handler failed", { error });
  }
}
