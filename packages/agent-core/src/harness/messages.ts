import {
  hasLegacyRuntimeContextEnvelope,
  labelRuntimeContextContent,
  RUNTIME_CONTEXT_CUSTOM_TYPE,
  type ImageContent,
  type Message,
  type TextContent,
} from "@openclaw/llm-core";
import { parseDateStringTimestampMs as parseSessionTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getOpenClawSystemUpdateKind } from "../operator-messages.js";
import type {
  AgentMessage,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "../types.js";

export type {
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "../types.js";

function requireSessionTimestampMs(value: string, label: string): number {
  const parsed = parseSessionTimestampMs(value);
  if (parsed === undefined) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeCompactionSummaryTimestamp(timestamp: number | string): number {
  if (typeof timestamp === "number") {
    return timestamp;
  }
  const parsed = parseSessionTimestampMs(timestamp);
  // Corrupt persisted rows should not abort context conversion; session order is already preserved.
  return parsed ?? 0;
}

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/** Render a shell execution record as user-visible context text for the model. */
export function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

/** Build a persisted branch summary message from the repository timestamp string. */
export function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string,
): BranchSummaryMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
    timestamp: requireSessionTimestampMs(timestamp, "branch summary timestamp"),
  };
}

/** Build a persisted compaction summary message from the repository timestamp string. */
export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string,
): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: requireSessionTimestampMs(timestamp, "compaction summary timestamp"),
  };
}

/** Build a custom transcript message that can be shown and replayed into context. */
export function createCustomMessage(
  customType: string,
  content: string | (TextContent | ImageContent)[],
  display: boolean,
  details: unknown,
  timestamp: string,
): CustomMessage {
  return {
    role: "custom",
    customType,
    content,
    display,
    details,
    timestamp: requireSessionTimestampMs(timestamp, "custom message timestamp"),
  };
}

/** Recognize the structured carrier marker shared with provider replay. */
export function isRuntimeContextCarrier(message: unknown): message is CustomMessage {
  const candidate = asOptionalRecord(message);
  const details = candidate?.role === "custom" ? asOptionalRecord(candidate.details) : undefined;
  return (
    candidate?.role === "custom" &&
    ((candidate.customType === RUNTIME_CONTEXT_CUSTOM_TYPE &&
      ((details?.source === "openclaw-runtime-context" &&
        details.runtimeContextCarrier !== false) ||
        (details?.source === undefined && details?.runtimeContextCarrier === true))) ||
      getOpenClawSystemUpdateKind(message) === "runtime-context")
  );
}

/** Convert harness transcript messages into the LLM-facing message sequence. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  const llmMessages: Message[] = [];
  // Preserve map's hole skipping and captured length without its intermediate array.
  messages.forEach((message) => {
    let content: (TextContent | ImageContent)[];
    switch (message.role) {
      case "bashExecution":
        if (message.excludeFromContext) {
          return;
        }
        content = [{ type: "text", text: bashExecutionToText(message) }];
        break;
      case "custom":
        if (message.excludeFromContext) {
          return;
        }
        content =
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content;
        break;
      case "branchSummary":
        content = [
          { type: "text", text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX },
        ];
        break;
      case "compactionSummary":
        content = [
          {
            type: "text",
            text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
          },
        ];
        break;
      case "user":
      case "assistant":
      case "toolResult":
        llmMessages.push(message);
        return;
      default:
        return;
    }
    const turnScoped = message.role === "custom" && asOptionalRecord(message.details)?.turnScoped;
    if (
      message.role === "custom" &&
      getOpenClawSystemUpdateKind(message) &&
      typeof turnScoped === "boolean"
    ) {
      llmMessages.push({
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
        operatorMessage: { turnScoped },
      });
      return;
    }
    const timestamp =
      message.role === "compactionSummary"
        ? normalizeCompactionSummaryTimestamp(message.timestamp)
        : message.timestamp;
    if (isRuntimeContextCarrier(message)) {
      if (content.some((block) => block.type === "image")) {
        llmMessages.push({
          role: "user",
          content,
          timestamp,
          runtimeContextCarrier: true,
        });
        return;
      }
      // Prefix-bound providers may have signed this exact v2026.9.7 projection.
      // Keep its historical bytes while attaching the canonical semantic marker.
      const textContent = content.filter((block): block is TextContent => block.type === "text");
      const legacyContent = hasLegacyRuntimeContextEnvelope(
        textContent.map((block) => block.text).join(""),
      )
        ? textContent
        : undefined;
      const runtimeContent =
        legacyContent ?? (typeof message.content === "string" ? message.content : textContent);
      llmMessages.push({
        role: "user",
        content: legacyContent ?? labelRuntimeContextContent(runtimeContent),
        timestamp,
        runtimeContext: {},
        runtimeContextCarrier: true,
      });
    } else {
      llmMessages.push({ role: "user", content, timestamp });
    }
  });
  return llmMessages;
}
