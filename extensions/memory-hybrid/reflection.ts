/**
 * Reflection Module
 *
 * Generates higher-order "meta-insights" from accumulated raw facts.
 *
 * How it works:
 * 1. Reads ALL memories from the database
 * 2. Groups them by category (preferences, facts, entities, decisions)
 * 3. Sends grouped facts to LLM asking for a "user profile reflection"
 * 4. Returns a structured summary that reveals patterns the individual facts don't show
 *
 * Example:
 *   Raw facts: "Uses Python", "Builds Telegram bots", "Learning with AI", "Lives in Ukraine"
 *   Reflection: "User is a Ukrainian developer who is self-teaching programming through
 *               AI-assisted tools, focusing on practical projects like Telegram bots."
 *
 * This goes BEYOND what Mem0, Zep, or any other memory system does today.
 * They store facts — we understand the person.
 */

import type { ChatModel } from "./chat.js";

// ============================================================================
// Types
// ============================================================================

export interface ReflectionResult {
  /** High-level summary of who the user is */
  summary: string;
  /** Key patterns detected across memories */
  patterns: string[];
  /** Emotional patterns detected (e.g. "stressed when coding at night") */
  emotionalPatterns: string[];
  /** Total memories analyzed */
  memoriesAnalyzed: number;
  /** Timestamp of reflection */
  generatedAt: number;
}

export interface MemoryFact {
  text: string;
  category: string;
  importance: number;
  recallCount?: number;
  emotionalTone?: string | null;
  emotionScore?: number | null;
  happenedAt?: string | null;
}

// ============================================================================
// Reflection Engine
// ============================================================================

/**
 * Generate a meta-reflection from accumulated memories.
 * Requires at least 5 memories to produce meaningful insights.
 */
export async function generateReflection(
  memories: MemoryFact[],
  chatModel: ChatModel,
): Promise<ReflectionResult> {
  if (memories.length < 5) {
    return {
      summary: "Not enough memories yet. Need at least 5 facts to generate a reflection.",
      patterns: [],
      emotionalPatterns: [],
      memoriesAnalyzed: memories.length,
      generatedAt: Date.now(),
    };
  }

  // 1. Sort by significance (Importance has higher weight, RecallCount boosts well-known facts)
  // Formula: Score = Importance * 10 + RecallCount
  const sorted = [...memories].sort((a, b) => {
    const scoreA = a.importance * 10 + (a.recallCount || 0);
    const scoreB = b.importance * 10 + (b.recallCount || 0);
    return scoreB - scoreA;
  });

  // 2. Take top 50 most significant memories (context window allows ~50 short facts easily)
  const topMemories = sorted.slice(0, 50);

  // Group by category for structured analysis
  const grouped: Record<string, string[]> = {};
  for (const m of topMemories) {
    const cat = m.category || "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m.text);
  }

  // Build prompt
  const factLines: string[] = [];
  for (const [category, facts] of Object.entries(grouped)) {
    factLines.push(`\n[${category.toUpperCase()}]`);
    for (const fact of facts) {
      factLines.push(`- ${fact}`);
    }
  }

  // Add emotional context
  const emotionalFacts = topMemories.filter(
    (m) => m.emotionalTone && m.emotionalTone !== "neutral",
  );
  if (emotionalFacts.length > 0) {
    factLines.push(`\n[EMOTIONAL CONTEXT]`);
    for (const m of emotionalFacts.slice(0, 15)) {
      const score =
        m.emotionScore != null
          ? ` (${m.emotionScore > 0 ? "+" : ""}${m.emotionScore.toFixed(1)})`
          : "";
      const when = m.happenedAt ? ` on ${m.happenedAt}` : "";
      factLines.push(`- [${m.emotionalTone}${score}${when}] ${m.text}`);
    }
  }

  const prompt = `You are a psychologist and data analyst. Analyze these facts about a user and produce:
1. A concise SUMMARY (2-3 sentences) describing who this person is, their interests, and their current focus.
2. A list of KEY PATTERNS you noticed (3-5 bullet points).
3. A list of EMOTIONAL PATTERNS — when/how the user's mood changes (2-4 bullet points).

Context: Today is ${new Date().toISOString().split("T")[0]}.
Facts are sorted by importance.

Facts about the user:
${factLines.join("\n")}

Return ONLY valid JSON:
{
  "summary": "...",
  "patterns": ["pattern1", "pattern2", "pattern3"],
  "emotional_patterns": ["pattern1", "pattern2"]
}`;

  try {
    const response = await chatModel.complete(
      [{ role: "user", content: prompt }],
      true, // JSON mode
    );

    const cleanJson = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const data = JSON.parse(cleanJson) as {
      summary?: string;
      patterns?: string[];
      emotional_patterns?: string[];
    };

    return {
      summary: data.summary || "Could not generate summary.",
      patterns: Array.isArray(data.patterns)
        ? data.patterns.filter((p): p is string => typeof p === "string")
        : [],
      emotionalPatterns: Array.isArray(data.emotional_patterns)
        ? data.emotional_patterns.filter((p): p is string => typeof p === "string")
        : [],
      memoriesAnalyzed: memories.length,
      generatedAt: Date.now(),
    };
  } catch (error) {
    console.warn(
      `[memory-hybrid][reflection] generateReflection JSON parse failed`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      summary: "Reflection failed (LLM error). Try again later.",
      patterns: [],
      emotionalPatterns: [],
      memoriesAnalyzed: memories.length,
      generatedAt: Date.now(),
    };
  }
}
