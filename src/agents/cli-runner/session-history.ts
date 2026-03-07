/*

Session History

Reads, formats, and appends conversation history for CLI backend
sessions. Provides the same context retention as the embedded Pi
runner by reading the shared session JSONL file and serializing
prior turns into the system prompt.

*/

import fs from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { extractAssistantText, sanitizeTextContent } from "../tools/sessions-helpers.js";

export type SessionTurn = {
  role: "user" | "assistant";
  text: string;
};

type JsonlEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

/**
 * Extract text content from a user message. User messages use
 * simple string content or an array of content blocks.
 */
function extractUserText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user") {
    return undefined;
  }
  const content = record.content;
  if (typeof content === "string") {
    return sanitizeTextContent(content).trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      const sanitized = sanitizeTextContent(rec.text);
      if (sanitized.trim()) {
        chunks.push(sanitized);
      }
    }
  }
  const joined = chunks.join("").trim();
  return joined || undefined;
}

/**
 * Read the session JSONL file and extract user/assistant text
 * turns. Tool messages are skipped entirely so only the
 * conversational text is returned.
 */
export async function readSessionHistory(sessionFile: string): Promise<SessionTurn[]> {
  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    return [];
  }

  const turns: SessionTurn[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const { role } = entry.message;
    if (role === "user") {
      const text = extractUserText(entry.message);
      if (text) {
        turns.push({ role: "user", text });
      }
    } else if (role === "assistant") {
      const text = extractAssistantText(entry.message);
      if (text) {
        turns.push({ role: "assistant", text });
      }
    }
    // Skip toolResult and other message types
  }
  return turns;
}

/**
 * Truncate to the last N user turns (and their associated
 * assistant responses), then format as a text section suitable
 * for injection into the system prompt. Returns undefined when
 * there is no prior history.
 */
export function formatHistoryForPrompt(turns: SessionTurn[], limit?: number): string | undefined {
  if (turns.length === 0) {
    return undefined;
  }

  // Apply turn limit (count user turns from the end)
  let limited = turns;
  if (limit && limit > 0) {
    let userCount = 0;
    let cutIndex = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        userCount++;
        if (userCount > limit) {
          cutIndex = i + 1;
          break;
        }
      }
    }
    if (cutIndex > 0) {
      limited = turns.slice(cutIndex);
    }
  }

  if (limited.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  for (const turn of limited) {
    const tag = turn.role === "user" ? "user" : "assistant";
    lines.push(`<${tag}>`);
    lines.push(turn.text);
    lines.push(`</${tag}>`);
    lines.push("");
  }

  return [
    "The following is the prior conversation with the user.",
    "Use this context to maintain continuity.",
    "IMPORTANT: Do not extend or continue this history. Do not",
    "generate <user> or <assistant> tags in your response.",
    "",
    "<conversation_history>",
    ...lines,
    "</conversation_history>",
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Patterns that indicate the model started generating fabricated
 * conversation turns (the "self-talk" bug). When the conversation
 * history uses [User]/[Assistant] or <user>/<assistant> labels,
 * the model sometimes continues the pattern in its response.
 * Truncate the response at the first match.
 */
const SELF_TALK_PATTERNS = [
  // Legacy bracket format
  /\n\[User\]\n/,
  /\n\[Assistant\]/,
  // XML tag format (opening and closing tags)
  /\n<\/?user>\s*\n?/,
  /\n<\/?assistant>\s*\n?/,
  // Bracket labels at the very start of a line (after a newline)
  /\n\[User\]\s*\n/,
];

/**
 * Strip self-talk from an assistant response. When the model
 * generates fabricated [User]/[Assistant] conversation turns as
 * part of its response, truncate at the first occurrence. Returns
 * the clean response text.
 */
export function stripSelfTalk(text: string): string {
  let earliest = text.length;
  for (const pattern of SELF_TALK_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < earliest) {
      earliest = match.index;
    }
  }
  if (earliest < text.length) {
    return text.slice(0, earliest).trimEnd();
  }
  return text;
}

/**
 * Append a user/assistant turn to the session JSONL file. Creates
 * the file with a session header if it does not yet exist. Uses a
 * write lock to avoid corrupting the file when multiple processes
 * write concurrently.
 */
export async function appendCliTurnToSession(params: {
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  const { sessionFile, sessionId, workspaceDir, userText, assistantText } = params;

  const dir = path.dirname(sessionFile);
  await fs.mkdir(dir, { recursive: true });

  const lock = await acquireSessionWriteLock({ sessionFile });
  try {
    // Check whether the file already has a session header.
    let needsHeader = true;
    try {
      const stat = await fs.stat(sessionFile);
      if (stat.size > 0) {
        needsHeader = false;
      }
    } catch {
      // File does not exist yet; we'll create it.
    }

    const lines: string[] = [];
    if (needsHeader) {
      lines.push(JSON.stringify({ type: "session", id: sessionId, cwd: workspaceDir }));
    }
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: userText },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      }),
    );

    await fs.appendFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  } finally {
    await lock.release();
  }
}
