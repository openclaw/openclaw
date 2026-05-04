import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: first read the recent conversation context from the current thread/channel with sessions_history when available, then run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get to pull only the needed lines. If the user uses a short deictic or anaphoric reference, regardless of language, interpret it from the immediately preceding thread/channel context first. If that nearby context does not confidently disambiguate the referent, use broader memory recall such as active context or memory files as supporting context, and if multiple plausible referents remain, say so briefly and ask a clarifying question instead of choosing one silently. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: first read the recent conversation context from the current thread/channel with sessions_history when available, then run memory_search on MEMORY.md + memory/*.md + indexed session transcripts and answer from the matching results. If the user uses a short deictic or anaphoric reference, regardless of language, interpret it from the immediately preceding thread/channel context first. If that nearby context does not confidently disambiguate the referent, use broader memory recall such as active context or memory files as supporting context, and if multiple plausible referents remain, say so briefly and ask a clarifying question instead of choosing one silently. If low confidence after search, say you checked.";
  } else {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: first read the recent conversation context from the current thread/channel with sessions_history when available, then run memory_get to pull only the needed lines. If the user uses a short deictic or anaphoric reference, regardless of language, interpret it from the immediately preceding thread/channel context first. If that nearby context does not confidently disambiguate the referent, use broader recall from the relevant notes as supporting context, and if multiple plausible referents remain, say so briefly and ask a clarifying question instead of choosing one silently. If low confidence after reading them, say you checked.";
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
