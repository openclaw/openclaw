/**
 * Smart Extractor — Atomic fact decomposition via single LLM call
 *
 * Design philosophy (differs from Pro's multi-pipeline approach):
 *
 *   Pro:  extract → classify → dedup → merge  (4 separate stages)
 *   Here: single LLM call that simultaneously decomposes, classifies,
 *         scores, and deduplicates against existing memories.
 *
 * Prompt design draws from three reference systems:
 *   - HonAgent: atomic fact decomposition, absolute time resolution,
 *     proper attribution to the correct subject
 *   - Memos: structured output (key/value/tags), third-person perspective,
 *     language matching, semantic dedup rules
 *   - Pro: category classification, importance scoring
 *
 * Key differentiators from Pro:
 *   1. "Atomic fact" granularity — each memory = one information point
 *   2. Third-person perspective enforced (not raw user text)
 *   3. Time resolution built into extraction (relative → absolute)
 *   4. Language matching (Chinese input → Chinese output)
 *   5. Structured key + tags for future retrieval enhancement
 */

import OpenAI from "openai";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./config.js";

export type ExtractedMemory = {
  key: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  tags: string[];
};

export type ExtractionResult = {
  memories: ExtractedMemory[];
  source: "llm" | "regex";
};

const EXTRACTION_PROMPT = `You are a memory extraction specialist. Analyze the conversation and decompose it into atomic, self-contained memories.

## Extraction Rules

1. **Atomic Facts Only**: Each memory must express exactly ONE primary information point. Do not bundle multiple facts into one memory.

2. **Self-Contained**: Every memory must be understandable without the original conversation. Resolve all pronouns, relative times, and ambiguous references into explicit forms.

3. **Third-Person Perspective**: Write from a third-person perspective. Use "the user" or the person's name — never "I", "me", "my".
   - Example: "The user prefers dark mode" NOT "I prefer dark mode"

4. **Time Resolution**: Convert relative time expressions to absolute dates when context allows. If uncertain, state it explicitly.
   - "yesterday" → "on June 25, 2025" (if message date is June 26)
   - "next Friday" → "on Friday, July 4, 2025"
   - If date cannot be determined: "around June 2025" or "date unknown"

5. **Proper Attribution**: If the user mentions someone else's actions or preferences, clearly attribute to that person. Do not attribute others' statements to the user.
   - "My colleague Alice uses Vim" → "The user's colleague Alice uses Vim"

6. **Language Matching**: Output in the same language as the input conversation. If input is Chinese, output Chinese. If English, output English.

7. **No Redundancy**: Do not create semantically overlapping memories. If two facts describe the same thing, keep only the more complete one.

8. **Category**: Assign each memory to exactly one category:
   - "preference": likes, dislikes, wants, style choices
   - "fact": objective information about the user or their context
   - "decision": choices or commitments the user has made
   - "entity": names, contacts, identifiers, affiliations
   - "other": anything that doesn't fit above

9. **Importance Scoring**:
   - 0.9–1.0: Identity-critical (name, contact, core identity preferences)
   - 0.7–0.9: Significant (preferences, decisions, important facts)
   - 0.5–0.7: General (contextual facts, minor preferences)
   - Below 0.5: Not worth storing — do not extract

10. **Skip**: Do NOT extract greetings, acknowledgments, denials, meta-questions about memory, system messages, or anything below importance 0.5.

11. **Deduplication**: If existing memories already cover a fact, skip it entirely.

## Output Format

Return valid JSON only, no markdown fences:
{"memories": [{"key": "concise unique title", "value": "complete self-contained memory statement", "category": "preference|fact|decision|entity|other", "importance": 0.0, "tags": ["keyword1", "keyword2"]}]}

If nothing is worth remembering: {"memories": []}

## Examples

Conversation (English):
user: I just switched from VS Code to Neovim last week and I love it. My email is dev@example.com.

Output:
{"memories": [{"key": "Editor switch to Neovim", "value": "The user switched from VS Code to Neovim and prefers Neovim.", "category": "preference", "importance": 0.8, "tags": ["editor", "neovim", "vscode"]}, {"key": "User email", "value": "The user's email address is dev@example.com.", "category": "entity", "importance": 0.9, "tags": ["email", "contact"]}]}

Conversation (Chinese):
user: 我上周六刚过了25岁生日，现在在纽约做前端开发。

Output:
{"memories": [{"key": "用户年龄与生日", "value": "用户25岁，生日在上周六。", "category": "fact", "importance": 0.8, "tags": ["年龄", "生日"]}, {"key": "用户工作地点与方向", "value": "用户在纽约从事前端开发工作。", "category": "fact", "importance": 0.7, "tags": ["工作", "纽约", "前端"]}]}`;

const MAX_INPUT_CHARS = 8000;

function buildExtractionInput(
  messages: string[],
  existingMemories: string[],
): string {
  const conversation = messages.join("\n").slice(0, MAX_INPUT_CHARS);
  const existing = existingMemories.length > 0
    ? `\n\nExisting memories (do not duplicate these):\n${existingMemories.map((m) => `- ${m}`).join("\n")}`
    : "";
  return `${EXTRACTION_PROMPT}\n\nConversation:\n${conversation}${existing}`;
}

export function parseExtractionResponse(raw: string): ExtractedMemory[] {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const memoriesArr = Array.isArray(root.memories) ? root.memories : [];

  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const results: ExtractedMemory[] = [];

  for (const item of memoriesArr) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const m = item as Record<string, unknown>;

    const value = typeof m.value === "string" ? m.value.trim() : "";
    const text = typeof m.text === "string" ? m.text.trim() : value;
    if (!text || text.length < 5) {
      continue;
    }

    const category = validCategories.has(String(m.category))
      ? (String(m.category) as MemoryCategory)
      : "other";

    const importance = typeof m.importance === "number"
      ? Math.min(1, Math.max(0, m.importance))
      : 0.7;

    if (importance < 0.5) {
      continue;
    }

    const key = typeof m.key === "string" ? m.key.trim() : text.slice(0, 40);

    const tags = Array.isArray(m.tags)
      ? m.tags.filter((t: unknown) => typeof t === "string").map(String)
      : [];

    results.push({ key, text, category, importance, tags });
  }

  return results;
}

export async function extractMemories(
  client: OpenAI,
  model: string,
  messages: string[],
  existingMemories: string[],
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  if (messages.length === 0) {
    return { memories: [], source: "llm" };
  }

  const input = buildExtractionInput(messages, existingMemories);

  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: input }],
        temperature: 0.1,
        max_tokens: 2048,
      },
      { signal },
    );

    const content = response.choices[0]?.message?.content ?? "";
    const memories = parseExtractionResponse(content);
    return { memories, source: "llm" };
  } catch {
    return { memories: [], source: "llm" };
  }
}
