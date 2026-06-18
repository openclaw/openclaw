import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildXMemoPromptSection: MemoryPromptSectionBuilder = ({ availableTools }) => {
  const lines: string[] = [];

  lines.push("## XMemo Cloud Memory");
  lines.push(
    "XMemo is enabled as the active long-term memory backend. Relevant project context, decisions, and prior fixes may be injected automatically or retrieved with the memory tools.",
  );

  if (availableTools.has("memory_search")) {
    lines.push(
      "- Use `memory_search` to recall relevant memories before answering questions about prior work.",
    );
  }
  if (availableTools.has("memory_store")) {
    lines.push(
      "- Use `memory_store` to persist durable decisions, conventions, bug fixes, and high-signal context.",
    );
  }
  if (availableTools.has("memory_forget")) {
    lines.push("- Use `memory_forget` to delete a memory by its path/id.");
  }
  if (availableTools.has("xmemo_todo_create")) {
    lines.push("- Use `xmemo_todo_create` to track actionable follow-ups in XMemo.");
  }
  if (availableTools.has("xmemo_record_event")) {
    lines.push(
      "- Use `xmemo_record_event` to record lightweight timeline milestones or decisions.",
    );
  }

  lines.push(
    "- Never store secrets, API keys, tokens, credentials, or sensitive customer data in XMemo.",
  );

  return lines;
};
