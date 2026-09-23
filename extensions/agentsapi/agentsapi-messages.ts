import {
  normalizeUsage,
  type AgentHarnessAttemptParamsV2,
  type NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { calculateCost, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { AgentsApiEvent, AgentsApiItem, AgentsApiTurn } from "./agentsapi-client.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];
type AgentsApiReply = {
  lastAssistant?: AssistantMessage;
  usage?: NormalizedUsage;
  assistantUsage: AssistantMessage["usage"];
};

export function createAgentsApiMessageProjection(
  remoteSessionId: string,
  emitEvent: (event: AgentEvent) => void | Promise<void>,
) {
  const reply: AgentsApiReply = { assistantUsage: emptyUsage() };
  const texts = new Map<string, Map<number, string>>();
  const assistantPhases = new Map<string, string | null | undefined>();
  let visibleAssistantItemId: string | undefined;
  const emitAssistantSnapshot = (itemId: string, text: string, delta = "") => {
    const replace = visibleAssistantItemId !== itemId;
    visibleAssistantItemId = itemId;
    // Steering can supersede a completed turn; append-only delivery waits for canonical items.
    void emitEvent({
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
  const complete = (turnId: string, text: string): void => {
    emitAssistantSnapshot(`agentsapi:${remoteSessionId}:${turnId}:reply`, text);
  };
  return {
    reply,
    recordUsage(model: AgentHarnessAttemptParamsV2["model"], turns: AgentsApiTurn[]): void {
      const usage = emptyUsage();
      let observed = false;
      let reasoningTokens: number | undefined;
      // Canonical turn snapshots replace SSE observations, never add to them.
      for (const turn of new Map(turns.map((record) => [record.id, record])).values()) {
        if (!turn.usage) {
          continue;
        }
        const normalized = normalizeUsage(turn.usage);
        if (!normalized) {
          continue;
        }
        observed = true;
        usage.input += normalized.input ?? 0;
        usage.output += normalized.output ?? 0;
        usage.cacheRead += normalized.cacheRead ?? 0;
        usage.totalTokens += normalized.total ?? turn.usage.input_tokens + turn.usage.output_tokens;
        if (normalized.reasoningTokens !== undefined) {
          reasoningTokens = (reasoningTokens ?? 0) + normalized.reasoningTokens;
        }
      }
      if (observed) {
        calculateCost(model, usage);
        reply.usage = {
          ...normalizeUsage(usage),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        };
      }
      reply.assistantUsage = usage;
    },
    observe(event: AgentsApiEvent): void {
      if (
        (event.type === "agent.session.turn.item.added" ||
          event.type === "agent.session.turn.item.done") &&
        event.item.type === "message" && event.item.role === "assistant" && event.item.id
      ) {
        assistantPhases.set(event.item.id, event.item.phase);
        if (event.type === "agent.session.turn.item.done") {
          const parts = new Map<number, string>();
          event.item.content?.forEach((part, index) => {
            if (part.type === "output_text") {
              parts.set(index, part.text ?? "");
            }
          });
          texts.set(event.item.id, parts);
        }
        const parts = texts.get(event.item.id);
        if (event.item.phase !== "commentary" && parts) {
          emitAssistantSnapshot(
            `agentsapi:${remoteSessionId}:${event.item.id}`,
            joinTextParts(parts),
          );
        }
      }
      if (
        event.type === "agent.session.turn.output_text.delta" ||
        event.type === "agent.session.turn.output_text.done"
      ) {
        if (!event.item_id) {
          throw new Error("Agents API text event has no item identity");
        }
        const parts = texts.get(event.item_id) ?? new Map<number, string>();
        const index = event.content_index ?? 0;
        parts.set(
          index,
          event.type === "agent.session.turn.output_text.done"
            ? event.text
            : (parts.get(index) ?? "") + event.delta,
        );
        texts.set(event.item_id, parts);
        if (
          assistantPhases.has(event.item_id) &&
          assistantPhases.get(event.item_id) !== "commentary"
        ) {
          emitAssistantSnapshot(
            `agentsapi:${remoteSessionId}:${event.item_id}`,
            joinTextParts(parts),
            event.type === "agent.session.turn.output_text.delta" ? event.delta : "",
          );
        }
      }
    },
    complete,
    commit(
      params: AgentHarnessAttemptParamsV2,
      turn: AgentsApiTurn,
      items: AgentsApiItem[],
      assertCurrent: () => void,
    ): Promise<void> {
      return commitAgentsApiReply(
        params,
        remoteSessionId,
        turn,
        items,
        assertCurrent,
        reply,
        complete,
      );
    },
  };
}

async function commitAgentsApiReply(
  params: AgentHarnessAttemptParamsV2,
  remoteSessionId: string,
  turn: AgentsApiTurn,
  items: AgentsApiItem[],
  assertCurrent: () => void,
  reply: AgentsApiReply,
  emitFinalReply: (turnId: string, text: string) => void | Promise<void>,
): Promise<void> {
  assertCurrent();
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
  if (
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    sessionId !== params.sessionId ||
    agentId !== params.agentId ||
    sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  const sessionTarget = { ...params.sessionTarget, agentId, sessionId, sessionKey, storePath };
  const completedMessages = items
    .filter((item) => item.type === "message")
    .filter((item) => item.role === "assistant" && item.status === "completed");
  const finalItems = completedMessages.filter((item) => item.phase === "final_answer");
  const visibleItems = finalItems.length
    ? finalItems
    : completedMessages.filter((item) => item.phase !== "commentary");
  const text = visibleItems
    .map(
      (item) =>
        item.content
          ?.filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join("") ?? "",
    )
    .join("\n");
  const usage = reply.assistantUsage;
  if (text) {
    const assistant: AssistantMessage & { idempotencyKey: string } = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "openai",
      model: params.model.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
      idempotencyKey: `agentsapi:${remoteSessionId}:${turn.id}`,
    };
    assertCurrent();
    const append = await appendSessionTranscriptMessageByIdentityStrict({
      ...sessionTarget,
      config: params.config,
      message: assistant,
      prepareMessageAfterIdempotencyCheck: (message) => {
        assertCurrent();
        return message;
      },
    });
    if (append.kind === "result") {
      reply.lastAssistant = append.result.message;
    }
    assertCurrent();
    if (append.kind !== "result") {
      throw new Error("Agents API assistant transcript append was refused");
    }
    await params.onAssistantMessageStart?.();
  }
  assertCurrent();
  await emitFinalReply(turn.id, text);
  assertCurrent();
  if (text) {
    await params.onPartialReply?.({ text });
    assertCurrent();
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    // Turn billing sums hosted model calls; it is not a latest-call context snapshot.
    contextUsage: { state: "unavailable" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function joinTextParts(parts: Map<number, string>): string {
  return [...parts.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("");
}
