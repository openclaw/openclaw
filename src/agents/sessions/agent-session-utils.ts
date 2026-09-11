import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { AssistantMessage } from "../../llm/types.js";
import type {
  BranchSummaryResult as CoreBranchSummaryResult,
  AgentMessage,
} from "../runtime/index.js";
import { estimateTokens } from "../runtime/index.js";
import {
  prepareCodeModeSourceAppend,
  takeCodeModeResponseSource,
} from "../transcript-code-mode-source.js";
import type { AppendPersistenceOptions } from "./session-manager-types.js";
import type { SessionManager } from "./session-manager.js";
import { reportSteeringMessagePersistenceFailure } from "./steering-message-identity.js";

export type AssistantAppendReceipt =
  | { kind: "committed"; parentId: string }
  | { kind: "suppressed"; parentId: string | null };

/** Capture before extension hooks; invoke only at the original message append boundary. */
export function prepareAgentSessionMessageAppend(
  sessionManager: SessionManager,
  sourceMessage: AgentMessage,
  receipts: WeakMap<AssistantMessage, AssistantAppendReceipt>,
) {
  const assistantAppend =
    sourceMessage.role === "assistant" && sessionManager.getSessionTarget()
      ? { message: sourceMessage, parentId: sessionManager.getAppendParentId() }
      : undefined;
  const resultOrigin =
    sourceMessage.role === "toolResult" ? getAgentToolExecutionContext() : undefined;
  const sourceSlots = takeCodeModeResponseSource(sourceMessage);
  return (
    message: Parameters<SessionManager["appendMessage"]>[0],
    invalidateSerializedPrefixCache: boolean,
  ): string | undefined => {
    let entryId: string | undefined;
    try {
      // Normalize live delivery facts before persistence makes its redacted copy.
      // Stored arguments must never replace the values used for tool execution.
      applyAssistantDeliveryDirectives(message);
      const appendOptions: AppendPersistenceOptions = { invalidateSerializedPrefixCache };
      if (resultOrigin && sessionManager.getSessionTarget()) {
        const receipt = receipts.get(resultOrigin.assistantMessage);
        if (!receipt) {
          throw new Error("Tool result has no observed assistant append boundary");
        }
        appendOptions.preparedTurnParentId = receipt.parentId;
      }
      prepareCodeModeSourceAppend(appendOptions, message, sourceSlots);
      entryId = sessionManager.appendMessage(message, appendOptions);
    } catch (error) {
      if (message.role === "user") {
        reportSteeringMessagePersistenceFailure(message, error);
      }
      throw error;
    }
    if (assistantAppend) {
      // A write hook may suppress the assistant without vetoing its tools.
      // Keep that prepared boundary, never a later completion-time cursor.
      receipts.set(
        assistantAppend.message,
        entryId === undefined
          ? { kind: "suppressed", parentId: assistantAppend.parentId }
          : { kind: "committed", parentId: entryId },
      );
    }
    return entryId;
  };
}

export function unwrapCoreResult<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

export function normalizeBranchSummaryResult(
  result:
    | { ok: true; value: CoreBranchSummaryResult }
    | { ok: false; error: { code: string; message: string } },
): {
  summary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  aborted?: boolean;
  error?: string;
} {
  if (result.ok) {
    return result.value;
  }
  if (result.error.code === "aborted") {
    return { aborted: true, error: result.error.message };
  }
  return { error: result.error.message };
}

export function hasPersistedAssistantContent(content: unknown): boolean {
  return (typeof content === "string" || Array.isArray(content)) && content.length > 0;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      text += candidate.text;
    }
  }
  return text;
}

export function replaceAgentMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
  // Agent-core stores the finalized message object before emitting message_end.
  // Mutating it in place keeps agent state, later events, and persistence in sync.
  if (target === replacement) {
    return;
  }
  for (const key of Object.keys(target)) {
    Reflect.deleteProperty(target, key);
  }
  Object.assign(target, replacement);
}

export function estimateMessagesFromContent(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}
