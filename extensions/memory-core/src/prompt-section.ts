// Memory Core plugin module implements prompt section behavior.
import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { shouldIncludeLongTermMemoryByDefault } from "openclaw/plugin-sdk/routing";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
  sessionKey,
  chatType,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (!shouldIncludeLongTermMemoryByDefault({ sessionKey, chatType })) {
    if (hasMemorySearch && hasMemoryGet) {
      toolGuidance =
        "Shared sessions do not run long-term memory recall by default. Use memory_search only when the user explicitly asks for long-term memory or a visible session instruction requests it; then use memory_get only for needed lines.";
    } else if (hasMemorySearch) {
      toolGuidance =
        "Shared sessions do not run long-term memory recall by default. Use memory_search only when the user explicitly asks for long-term memory or a visible session instruction requests it.";
    } else {
      toolGuidance =
        "Shared sessions do not read long-term memory by default. Use memory_get only when the user explicitly asks for a memory file excerpt or a visible session instruction requests it.";
    }
  } else if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts and answer from the matching results. If low confidence after search, say you checked.";
  } else {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
  }

  const lines = ["## Memory Recall", toolGuidance];
  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
