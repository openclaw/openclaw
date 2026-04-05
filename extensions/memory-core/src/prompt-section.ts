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

  const lines = [
    "## Memory",
    "",
    "Memory is calibration, not reference. Store what shifts your behavior. If you could generate it from your weights alone, don't store it.",
    "",
    "Memory has three functions:",
    "- **Reminder**: what you'd otherwise lose between sessions",
    "- **Correction**: where your defaults are wrong for this user",
    "- **Pointer**: where to look, not what's there",
    "",
    "### MEMORY.md structure",
    "",
    "Line 1 is always the recovery pointer — where you left off:",
    "",
    "```",
    "## recovery",
    "[last-session: <date> | <one-line state summary>]",
    "",
    "## routing",
    "- [match-term] — filename.md — <what it calibrates>",
    "- [match-term] — filename.md — <what it calibrates>",
    "- [default] user_preferences.md — always load",
    "",
    "## state",
    "- active: <current focus or project>",
    "- decided: <decisions that constrain future responses>",
    "- anti-drift: <corrections to your natural tendencies for this user>",
    "",
    "## index",
    "- filename.md — <one-line description>",
    "- filename.md — <one-line description>",
    "```",
    "",
    hasMemorySearch
      ? "The routing zone matches against the current input. Load the file only when the match-term appears. The state zone loads every session. The index zone is for `memory_search` — pointers only, never content."
      : "The routing zone matches against the current input. Load the file only when the match-term appears. The state zone loads every session. The index zone lists memory files — pointers only, never content.",
    "",
    "### Four moments of memory work",
    "",
    "**WRITE** — when storing new memory:",
    "Resist the pull to store everything. Before writing, ask: does this calibrate me, or could I regenerate it? Store the correction, not the knowledge. Store the preference, not the fact.",
    "",
    "**RETRIEVE** — when searching memory:",
    hasMemorySearch && hasMemoryGet
      ? "Resist the pull to search narrowly. Cast wide with `memory_search`, then use `memory_get` to pull only the needed lines. A memory file you never find is worse than one you never wrote."
      : hasMemorySearch
        ? "Resist the pull to search narrowly. Cast wide with `memory_search` and answer from the matching results. A memory file you never find is worse than one you never wrote."
        : "Before answering about prior work, decisions, or preferences that point to a specific memory file: use `memory_get` to pull only the needed lines. If low confidence after reading, say you checked.",
    "",
    "**MAINTAIN** — when reviewing stored memory:",
    "Resist the pull to keep everything. Delete what your weights already know. Merge what has converged. A memory system that only grows eventually drowns the signal.",
    "",
    "**CHECK** — when memory contradicts current evidence:",
    "Resist the pull to ignore the contradiction. If what you stored disagrees with what you observe, one of them is wrong. Update the memory or flag the conflict. Never silently serve stale state.",
    "",
    "### Heartbeat maintenance",
    "",
    "Every heartbeat cycle: review one memory file for staleness, prune what no longer calibrates, update the recovery pointer.",
    "",
    "### Self-audit triggers",
    "",
    "- If you answer a preference question from your defaults instead of checking memory — you skipped RETRIEVE.",
    "- If you store a fact you already know (common syntax, public knowledge, general patterns) — you failed the WRITE filter.",
    "- If a memory file has not been accessed in 5+ sessions — it is a candidate for MAINTAIN pruning.",
    "- If the user corrects you on something you have a memory entry for — your CHECK moment failed. Update immediately.",
    "- If your routing zone has more than 15 entries — consolidate. Routing that requires scanning is routing that fails.",
    "",
    "### File format",
    "",
    "Each memory file in `memory/` is plain markdown. First line: `# <title>`. No frontmatter. No metadata beyond what the content says. Keep files under 50 lines — if longer, split or compress. (MEMORY.md follows its own structure above — this rule applies to content files, not the index.)",
    "",
    "Write memories as instructions to your future self: \"User prefers X\" not \"I learned that the user prefers X.\"",
  ];

  if (citationsMode === "off") {
    lines.push(
      "",
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "",
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
