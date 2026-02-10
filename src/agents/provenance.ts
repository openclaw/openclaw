import { normalizeToolName } from "./tool-policy.js";

const TAINT_SOURCE_TOOLS = new Set<string>([
  "web_fetch",
  "web_search",
  "browser",
  // Legacy/alternate names seen in older tool schemas.
  "read_url_content",
  "read_browser_page",
  "fetch_page_content",
]);

const TAINT_SINK_TOOLS = new Set<string>([
  "exec",
  "write",
  "edit",
  "apply_patch",
  "message",
  "sessions_send",
  // Legacy/alternate names seen in older tool schemas.
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

const MIN_SNIPPET_CHARS = 24;
const MAX_SNIPPET_CHARS = 280;
const MAX_TRACKED_SNIPPETS = 256;
const MAX_TRACKED_SESSIONS = 256;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringifyForMatch(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function splitIntoSnippets(content: string): string[] {
  const normalizedLines = content
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter((line) => line.length >= MIN_SNIPPET_CHARS)
    .map((line) => line.slice(0, MAX_SNIPPET_CHARS));
  return Array.from(new Set(normalizedLines));
}

export class ProvenanceTracker {
  private taintedSnippets = new Set<string>();
  private snippetOrder: string[] = [];

  private static instances = new Map<string, ProvenanceTracker>();

  static getInstance(sessionKey: string): ProvenanceTracker {
    const normalizedKey = normalizeText(sessionKey);
    const key = normalizedKey || "default";
    const existing = this.instances.get(key);
    if (existing) {
      return existing;
    }
    const created = new ProvenanceTracker();
    this.instances.set(key, created);

    while (this.instances.size > MAX_TRACKED_SESSIONS) {
      const oldestKey = this.instances.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.instances.delete(oldestKey);
    }

    return created;
  }

  // Test helper.
  static clearAllForTesting() {
    this.instances.clear();
  }

  recordTaint(toolName: string, content: string) {
    const normalizedToolName = normalizeToolName(toolName);
    if (!TAINT_SOURCE_TOOLS.has(normalizedToolName)) {
      return;
    }
    for (const snippet of splitIntoSnippets(content)) {
      if (this.taintedSnippets.has(snippet)) {
        continue;
      }
      this.taintedSnippets.add(snippet);
      this.snippetOrder.push(snippet);
      if (this.snippetOrder.length > MAX_TRACKED_SNIPPETS) {
        const removed = this.snippetOrder.shift();
        if (removed) {
          this.taintedSnippets.delete(removed);
        }
      }
    }
  }

  isTainted(params: unknown): { tainted: boolean; evidence?: string } {
    const haystack = normalizeText(stringifyForMatch(params));
    if (!haystack) {
      return { tainted: false };
    }
    for (const snippet of this.taintedSnippets) {
      if (haystack.includes(snippet)) {
        return {
          tainted: true,
          evidence: snippet.slice(0, 80),
        };
      }
    }
    return { tainted: false };
  }

  isSink(toolName: string): boolean {
    return TAINT_SINK_TOOLS.has(normalizeToolName(toolName));
  }
}
