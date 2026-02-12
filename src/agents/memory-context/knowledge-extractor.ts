/**
 * Knowledge Extractor -- extracts structured technical facts from conversation messages.
 *
 * Uses LLM to extract facts in a Mem0-inspired pipeline, but with prompts
 * adapted for coding agent sessions (decisions, implementations, configs, etc.).
 *
 * Falls back to a no-op when no LLM is available (e.g., in tests).
 */

import type { KnowledgeFactType } from "./knowledge-store.js";

export type ExtractedFact = {
  type: KnowledgeFactType;
  content: string;
  context?: string;
};

export type LLMCallFn = (prompt: string) => Promise<string>;

const EXTRACTION_PROMPT = `You are a Technical Knowledge Extractor for a coding agent session.
Extract key technical facts from the conversation below.

Types to extract:
1. decision: Technical or design decisions made (e.g., "Use PostgreSQL instead of MySQL")
2. implementation: Key implementation details (e.g., "Webhook endpoint is /api/stripe/webhook")
3. config: Non-secret configuration values, endpoints, paths (e.g., "Deploy to 168.119.x.x via Docker")
4. issue: Known bugs, limitations, or workarounds discovered
5. task_state: Current state of ongoing work (e.g., "Refund logic not yet implemented")
6. architecture: System design choices (e.g., "Event-driven with Redis pub/sub")

Rules:
- Extract ONLY genuinely important technical facts
- Keep each fact as a single concise sentence
- Preserve specific values (URLs, port numbers, file paths, variable names)
- NEVER extract secrets, passwords, API keys, or authentication tokens
- Do NOT extract greetings, small talk, or generic statements
- Detect language of conversation and record facts in the same language
- Max 15 facts per extraction
- Return ONLY valid JSON, no markdown or extra text

Do NOT extract:
- Greeting, small talk, or acknowledgement messages ("ok", "thanks", "got it")
- Information already captured in a previous extraction (avoid duplicates)
- Temporary debugging steps that were later reverted
- Speculative ideas that were explicitly not adopted
- File content that was merely read/displayed (extract decisions about it, not the content itself)

Return JSON: {"facts": [{"type": "...", "content": "...", "context": "..."}]}

Conversation:
`;

const MIN_MESSAGES_FOR_EXTRACTION = 5;
const MAX_INPUT_CHARS = 8000;

/**
 * Extract an AgentMessage-like object's text content.
 */
function extractMessageText(msg: { role?: string; content?: unknown }): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: string }).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Format messages into a conversation block for the extraction prompt.
 */
function formatConversation(messages: Array<{ role?: string; content?: unknown }>): string {
  const lines: string[] = [];
  for (const msg of messages) {
    // Only include user and assistant messages in extraction context
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }
    const role = msg.role === "assistant" ? "Assistant" : "User";
    const text = extractMessageText(msg).trim();
    if (!text) {
      continue;
    }
    lines.push(`${role}: ${text}`);
  }
  let result = lines.join("\n\n");
  if (result.length > MAX_INPUT_CHARS) {
    result = result.slice(0, MAX_INPUT_CHARS) + "\n...(truncated)";
  }
  return result;
}

/**
 * Parse the LLM response JSON into structured facts.
 * Handles common LLM quirks (markdown fences, trailing text).
 */
function parseFactsResponse(response: string): ExtractedFact[] {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }

  // Find the JSON object
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }

  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
      facts?: Array<{ type?: string; content?: string; context?: string }>;
    };
    if (!obj.facts || !Array.isArray(obj.facts)) {
      return [];
    }

    const validTypes = new Set<string>([
      "decision",
      "implementation",
      "config",
      "issue",
      "task_state",
      "architecture",
    ]);

    return obj.facts
      .filter(
        (f) =>
          f &&
          typeof f.content === "string" &&
          f.content.trim().length > 0 &&
          typeof f.type === "string" &&
          validTypes.has(f.type),
      )
      .slice(0, 15)
      .map((f) => ({
        type: f.type as KnowledgeFactType,
        content: f.content!.trim(),
        context: typeof f.context === "string" ? f.context.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Extract knowledge facts from a batch of messages.
 *
 * @param messages - The messages to extract from (messagesToSummarize)
 * @param llmCall - Function to call the LLM
 * @returns Array of extracted facts (may be empty)
 */
export async function extractKnowledge(
  messages: Array<{ role?: string; content?: unknown }>,
  llmCall: LLMCallFn,
): Promise<ExtractedFact[]> {
  // Skip extraction for very small batches
  if (messages.length < MIN_MESSAGES_FOR_EXTRACTION) {
    return [];
  }

  const conversation = formatConversation(messages);
  if (conversation.trim().length < 50) {
    return [];
  }

  const prompt = EXTRACTION_PROMPT + conversation;

  try {
    const response = await llmCall(prompt);
    return parseFactsResponse(response);
  } catch {
    return [];
  }
}

// Export internals for testing
export const __testing = {
  formatConversation,
  parseFactsResponse,
  EXTRACTION_PROMPT,
  MIN_MESSAGES_FOR_EXTRACTION,
};
