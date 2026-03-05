/**
 * Iris Stage 4 — cross-session long-term memory.
 *
 * On /new or /reset: extract the last few user↔agent turns and save to
 * {agentDir}/iris-memory.md so the next session can pick it up.
 *
 * On next session start: load the file and inject into extraSystemPrompt
 * so the agent remembers what was being worked on.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const IRIS_MEMORY_FILE = "iris-memory.md";

const MAX_USER_CHARS = 400;
const MAX_ASST_CHARS = 700;
const MAX_TURNS = 4;

type Block = { type?: string; text?: string };
type Msg = { role?: string; content?: Block[] | string };

function extractText(content: Block[] | string | undefined): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function trunc(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return trimmed.slice(0, max) + "…";
}

/**
 * Build a compact markdown summary of the last N user↔agent pairs.
 * Returns undefined if there's nothing worth saving.
 */
export function buildSessionMemory(messages: unknown[], date: string): string | undefined {
  const typed = messages as Msg[];
  // Collect only user and assistant messages (skip toolResult, system, etc.)
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const msg of typed) {
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }
    const text = extractText(msg.content);
    if (!text) {
      continue;
    }
    turns.push({ role: msg.role, text });
  }

  if (turns.length === 0) {
    return undefined;
  }

  // Take the last MAX_TURNS*2 entries (MAX_TURNS user + MAX_TURNS assistant interleaved)
  const recent = turns.slice(-MAX_TURNS * 2);

  const lines: string[] = [
    `<!-- iris-memory: ${date} -->`,
    "## Previous session context",
    "",
    "*(Last conversation turns — injected automatically)*",
    "",
  ];

  for (const t of recent) {
    if (t.role === "user") {
      lines.push(`**User:** ${trunc(t.text, MAX_USER_CHARS)}`);
    } else {
      lines.push(`**Agent:** ${trunc(t.text, MAX_ASST_CHARS)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Save session memory to {agentDir}/iris-memory.md. Fire-and-forget safe. */
export async function saveSessionMemory(agentDir: string, messages: unknown[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const content = buildSessionMemory(messages, date);
  if (!content) {
    return;
  }
  const dest = path.join(agentDir, IRIS_MEMORY_FILE);
  await fs.writeFile(dest, content, "utf-8");
}

/** Load session memory from {agentDir}/iris-memory.md. Returns undefined if absent. */
export async function loadSessionMemory(agentDir: string): Promise<string | undefined> {
  const src = path.join(agentDir, IRIS_MEMORY_FILE);
  try {
    const raw = await fs.readFile(src, "utf-8");
    return raw.trim() || undefined;
  } catch {
    return undefined;
  }
}
