import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-host-core";

export const buildWikiPromptSection: MemoryPromptSectionBuilder = ({ availableTools }) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasWikiSearch = availableTools.has("wiki_search");
  const hasWikiGet = availableTools.has("wiki_get");
  const hasWikiApply = availableTools.has("wiki_apply");
  const hasWikiLint = availableTools.has("wiki_lint");

  if (
    !hasMemorySearch &&
    !hasMemoryGet &&
    !hasWikiSearch &&
    !hasWikiGet &&
    !hasWikiApply &&
    !hasWikiLint
  ) {
    return [];
  }

  const lines = [
    "## Compiled Wiki",
    "Use the wiki when the answer depends on accumulated project knowledge, prior syntheses, entity pages, or source-backed notes that should survive beyond one conversation.",
  ];

  if (hasMemorySearch) {
    lines.push(
      "Prefer `memory_search` with `corpus=all` for one recall pass across durable memory and the compiled wiki when both are relevant.",
    );
  }
  if (hasMemoryGet) {
    lines.push(
      "Use `memory_get` with `corpus=wiki` or `corpus=all` when you already know the page path and want a small excerpt without leaving the shared memory tool flow.",
    );
  }

  if (hasWikiSearch && hasWikiGet) {
    lines.push(
      "Workflow: `wiki_search` first, then `wiki_get` for the exact page or imported memory file you need. Use this when you want wiki-specific ranking or provenance details instead of the broader shared memory flow.",
    );
  } else if (hasWikiSearch) {
    lines.push(
      "Use `wiki_search` before answering from stored knowledge when you want wiki-specific ranking or provenance details.",
    );
  } else if (hasWikiGet) {
    lines.push(
      "Use `wiki_get` to inspect specific wiki pages or imported memory files by path/id.",
    );
  }

  if (hasWikiApply) {
    lines.push(
      "Use `wiki_apply` for narrow synthesis filing and metadata repair instead of rewriting managed markdown blocks by hand.",
    );
  }
  if (hasWikiLint) {
    lines.push("After meaningful wiki updates, run `wiki_lint` before trusting the vault.");
  }
  lines.push("");
  return lines;
};
