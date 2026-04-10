import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasDaliLocalV1RetrieveContext = availableTools.has("dali_local_v1_retrieve_context");

  if (!hasMemorySearch && !hasMemoryGet && !hasDaliLocalV1RetrieveContext) {
    return [];
  }

  const lines: string[] = [];

  if (hasMemorySearch || hasMemoryGet) {
    let toolGuidance: string;
    if (hasMemorySearch && hasMemoryGet) {
      toolGuidance =
        "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get to pull only the needed lines. If memory does not clearly verify the answer, say so and do not guess.";
    } else if (hasMemorySearch) {
      toolGuidance =
        "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts and answer from the matching results. If memory does not clearly verify the answer, say so and do not guess.";
    } else {
      toolGuidance =
        "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If memory does not clearly verify the answer, say so and do not guess.";
    }

    lines.push("## Memory Recall", toolGuidance);
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
  }

  if (hasDaliLocalV1RetrieveContext) {
    lines.push(
      "## Dali Local-v1 Retrieval",
      "If the question needs the workspace's Dali/local-v1 SQLite document corpus or local reflections, run dali_local_v1_retrieve_context. It returns Dali/local-v1-specific context from the imported document store and reflection text index; do not describe it as generic global memory.",
    );
    lines.push("");
  }
  return lines;
};
