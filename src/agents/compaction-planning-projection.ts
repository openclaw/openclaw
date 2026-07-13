/** Builds bounded transcript projections for compaction worker planning. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "./runtime/index.js";

const TEXT_TRUNCATE_THRESHOLD_CHARS = 32_768;
const TEXT_SAMPLE_CHARS = 8_192;
const OMITTED_CHARS_FIELD = "__openclawCompactionPlanningOmittedChars";

export function readCompactionPlanningOmittedChars(message: AgentMessage): number {
  const value = (message as unknown as Record<string, unknown>)[OMITTED_CHARS_FIELD];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function projectText(text: string): { text: string; omittedChars: number } | null {
  if (text.length <= TEXT_TRUNCATE_THRESHOLD_CHARS) {
    return null;
  }
  const sample = truncateUtf16Safe(text, TEXT_SAMPLE_CHARS);
  const droppedChars = text.length - sample.length;
  const projected = `${sample}\n\n[... ${droppedChars} characters omitted from compaction planning]`;
  return {
    text: projected,
    omittedChars: Math.max(0, text.length - projected.length),
  };
}

function projectContentBlock(
  block: unknown,
  projectTextContent: boolean,
): { block: unknown; omittedChars: number; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, omittedChars: 0, changed: false };
  }
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "image" && typeof record.data === "string" && record.data.length > 0) {
    return {
      block: { ...record, data: "" },
      omittedChars: 0,
      changed: true,
    };
  }
  if (!projectTextContent) {
    return { block, omittedChars: 0, changed: false };
  }
  const textIsModelVisible =
    type === "text" ||
    ((type === "toolResult" || type === "tool_result") && typeof record.text === "string");
  const contentIsModelVisible =
    (type === "toolResult" || type === "tool_result") &&
    typeof record.text !== "string" &&
    typeof record.content === "string";
  const projectedText = typeof record.text === "string" ? projectText(record.text) : null;
  const projectedContent = typeof record.content === "string" ? projectText(record.content) : null;
  if (!projectedText && !projectedContent) {
    return { block, omittedChars: 0, changed: false };
  }
  const next = { ...record };
  let omittedChars = 0;
  if (projectedText) {
    next.text = projectedText.text;
    omittedChars += textIsModelVisible ? projectedText.omittedChars : 0;
  }
  if (projectedContent) {
    next.content = projectedContent.text;
    omittedChars += contentIsModelVisible ? projectedContent.omittedChars : 0;
  }
  return { block: next, omittedChars, changed: true };
}

function projectMessage(message: AgentMessage): AgentMessage {
  const currentOmittedChars = readCompactionPlanningOmittedChars(message);
  const content = (message as { content?: unknown }).content;
  if (message.role === "toolResult" && typeof content === "string") {
    const projected = projectText(content);
    if (!projected) {
      return message;
    }
    return {
      ...(message as unknown as Record<string, unknown>),
      content: projected.text,
      [OMITTED_CHARS_FIELD]: currentOmittedChars + projected.omittedChars,
    } as unknown as AgentMessage;
  }
  if (!Array.isArray(content)) {
    return message;
  }

  let omittedChars = 0;
  let changed = false;
  const projectedContent = content.map((block) => {
    const projected = projectContentBlock(block, message.role === "toolResult");
    omittedChars += projected.omittedChars;
    changed ||= projected.changed;
    return projected.block;
  });
  if (!changed) {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    content: projectedContent,
    [OMITTED_CHARS_FIELD]: currentOmittedChars + omittedChars,
  } as unknown as AgentMessage;
}

export function projectCompactionPlanningMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(projectMessage);
}
