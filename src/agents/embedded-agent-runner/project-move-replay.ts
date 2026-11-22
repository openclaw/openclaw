import { NATIVE_HISTORICAL_TOOL_CALL } from "@openclaw/ai/provider-types";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  PROJECT_MOVE_HANDOFF_NAME,
  buildSessionToolHandoffNotice,
} from "../sessions-yield-context.js";

const moveNotice = buildSessionToolHandoffNotice(PROJECT_MOVE_HANDOFF_NAME);

/** Fold a host-confirmed move in the provider view after the continuation input is present. */
export function projectCompletedProjectMoves(messages: AgentMessage[]): AgentMessage[] {
  const changes = new Map<number, AgentMessage | undefined>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    const completed = normalizeInputProvenance(
      Reflect.get(message, "provenance"),
    )?.completedToolCall;
    if (!completed) {
      continue;
    }
    const receiptIndex = messages.findLastIndex(
      (item, offset) =>
        offset < index &&
        item.role === "toolResult" &&
        item.toolName === "session_project" &&
        item.toolCallId === completed.id,
    );
    const receipt = messages[receiptIndex];
    if (receipt?.role !== "toolResult" || receipt.isError || changes.has(receiptIndex)) {
      continue;
    }
    // The original call can have sibling results on either side of its receipt.
    let assistantIndex = receiptIndex - 1;
    while (messages[assistantIndex]?.role === "toolResult") {
      assistantIndex--;
    }
    const assistant = changes.get(assistantIndex) ?? messages[assistantIndex];
    if (assistant?.role !== "assistant") {
      continue;
    }
    const call = assistant.content.find(
      (block) =>
        block.type === "toolCall" &&
        block.id === completed.id &&
        block.name === receipt.toolName &&
        block.arguments?.action === "move",
    );
    if (!call) {
      continue;
    }
    const historicalCall = { ...call, [NATIVE_HISTORICAL_TOOL_CALL]: true };
    changes.set(assistantIndex, {
      ...assistant,
      content: assistant.content.map((block) => (block === call ? historicalCall : block)),
    });
    changes.set(receiptIndex, {
      ...receipt,
      content: [{ type: "text", text: completed.result }],
    });
    let noticeIndex = receiptIndex + 1;
    while (messages[noticeIndex]?.role === "toolResult") {
      noticeIndex++;
    }
    const notice = messages[noticeIndex];
    if (
      notice?.role === "custom" &&
      notice.customType === "openclaw.sessions_yield" &&
      asOptionalObjectRecord(notice.details)?.message === moveNotice
    ) {
      changes.set(noticeIndex, undefined);
    }
    changes.set(index, undefined);
  }
  return changes.size === 0
    ? messages
    : messages.flatMap((message, index) =>
        changes.has(index) ? (changes.get(index) ?? []) : message,
      );
}
/** Describe the retired move tool in the model's history without teaching a text tool-call syntax. */
export function describePastProjectMoves(messages: AgentMessage[]): AgentMessage[] {
  let projected: AgentMessage[] | undefined;
  let assistantIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "toolResult") {
      assistantIndex = message.role === "assistant" ? (projected?.length ?? index) : -1;
    } else if (
      message.toolName === "session_project" &&
      message.content.length === 1 &&
      message.content[0]?.type === "text"
    ) {
      // Parallel results belong to the preceding assistant, even if another tool finished first.
      const assistant = (projected ?? messages)[assistantIndex];
      if (assistant?.role === "assistant") {
        const call = assistant.content.find(
          (block) => block.type === "toolCall" && block.id === message.toolCallId,
        );
        if (
          call?.type === "toolCall" &&
          call.name === message.toolName &&
          call.arguments?.action === "move"
        ) {
          const text = `Earlier project move request: ${JSON.stringify(call.arguments)}\nGateway receipt: ${message.content[0].text}`;
          projected ??= messages.slice(0, index);
          projected[assistantIndex] = {
            ...assistant,
            content: assistant.content.map((block) =>
              block === call ? { type: "text", text } : block,
            ),
          };
          continue;
        }
      }
    }
    projected?.push(message);
  }
  return projected ?? messages;
}
