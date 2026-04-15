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

  // File-based memory architecture instructions (moved from workspace templates
  // so that memory-core owns its own persistence instructions and custom memory
  // plugins can supply their own without conflicting with template content).
  lines.push(
    "",
    "## Memory Persistence",
    "",
    "You wake up fresh each session. These files are your continuity:",
    "",
    "- **Daily notes:** `memory/YYYY-MM-DD.md` (create `memory/` if needed) — raw logs of what happened",
    "- **Long-term:** `MEMORY.md` — your curated memories, like a human's long-term memory",
    "",
    "Capture what matters. Decisions, context, things to remember. Skip the secrets unless asked to keep them.",
    "",
    "### MEMORY.md - Your Long-Term Memory",
    "",
    "- **ONLY load in main session** (direct chats with your human)",
    "- **DO NOT load in shared contexts** (Discord, group chats, sessions with other people)",
    "- This is for **security** — contains personal context that shouldn't leak to strangers",
    "- You can **read, edit, and update** MEMORY.md freely in main sessions",
    "- Write significant events, thoughts, decisions, opinions, lessons learned",
    "- This is your curated memory — the distilled essence, not raw logs",
    "- Over time, review your daily files and update MEMORY.md with what's worth keeping",
    "",
    "### Write It Down - No Mental Notes",
    "",
    "- **Memory is limited** — if you want to remember something, WRITE IT TO A FILE",
    "- Mental notes don't survive session restarts. Files do.",
    "- When someone says \"remember this\" → update `memory/YYYY-MM-DD.md` or relevant file",
    "- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill",
    "- When you make a mistake → document it so future-you doesn't repeat it",
    "",
    "### Memory Maintenance (During Heartbeats)",
    "",
    "Periodically (every few days), use a heartbeat to:",
    "",
    "1. Read through recent `memory/YYYY-MM-DD.md` files",
    "2. Identify significant events, lessons, or insights worth keeping long-term",
    "3. Update `MEMORY.md` with distilled learnings",
    "4. Remove outdated info from MEMORY.md that's no longer relevant",
    "",
    "Think of it like a human reviewing their journal and updating their mental model. Daily files are raw notes; MEMORY.md is curated wisdom.",
    "",
  );

  return lines;
};
