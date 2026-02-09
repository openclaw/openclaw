/**
 * Router classifier — uses a small local LLM to classify user intent.
 *
 * Calls the router model (Qwen 3B via Ollama) with a structured prompt
 * that returns JSON classification of the user's request.
 */

import type { Classification, Intent } from "../types.js";

const VALID_INTENTS: Intent[] = [
  "email_draft", "email_send", "email_read",
  "web_search", "web_scrape",
  "purchase", "booking",
  "code_simple", "code_complex",
  "deploy", "research", "form_fill",
  "schedule_task", "general_chat", "unknown",
];

/**
 * Build the classification prompt for the router model.
 */
export function buildClassifierPrompt(userMessage: string): string {
  return `You are a task classifier. Analyze the user's message and classify it.

Respond with ONLY valid JSON, no other text.

Valid intents: ${VALID_INTENTS.join(", ")}

JSON schema:
{
  "intent": "<one of the valid intents>",
  "confidence": <0.0 to 1.0>,
  "complexity": "<low|medium|high>",
  "tools_needed": ["<tool names>"],
  "recommended_engine": "<local|cloud>",
  "reasoning": "<brief explanation>"
}

Rules:
- Purchases and bookings are always "high" complexity and "cloud" engine
- Simple questions and chat are "low" complexity and "local" engine
- Code that involves multiple files or architecture is "code_complex"
- Code that is a small fix or single file is "code_simple"
- Deployment is always "cloud" engine
- If unsure, use "unknown" intent with "cloud" engine

User message: "${userMessage}"

JSON:`;
}

/**
 * Parse the classifier output into a Classification object.
 * Handles common LLM output quirks (markdown fences, extra text).
 */
export function parseClassification(raw: string): Classification | null {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Find the JSON object in the output
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate intent
    const intent: Intent = VALID_INTENTS.includes(parsed.intent)
      ? parsed.intent
      : "unknown";

    // Validate confidence
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    // Validate complexity
    const complexity = ["low", "medium", "high"].includes(parsed.complexity)
      ? (parsed.complexity as "low" | "medium" | "high")
      : "medium";

    // Validate engine
    const recommended_engine = ["local", "cloud"].includes(parsed.recommended_engine)
      ? (parsed.recommended_engine as "local" | "cloud")
      : "cloud";

    return {
      intent,
      confidence,
      complexity,
      tools_needed: Array.isArray(parsed.tools_needed) ? parsed.tools_needed : [],
      recommended_engine,
      reasoning: parsed.reasoning ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Default classification when the router model fails or returns garbage.
 */
export function fallbackClassification(userMessage: string): Classification {
  // Simple heuristics as a last resort
  const lower = userMessage.toLowerCase();

  if (lower.includes("email") || lower.includes("mail")) {
    return {
      intent: lower.includes("send") ? "email_send" : "email_draft",
      confidence: 0.6,
      complexity: "low",
      tools_needed: ["email"],
      recommended_engine: "local",
    };
  }

  if (lower.includes("search") || lower.includes("google") || lower.includes("look up")) {
    return {
      intent: "web_search",
      confidence: 0.6,
      complexity: "low",
      tools_needed: ["search"],
      recommended_engine: "local",
    };
  }

  if (lower.includes("buy") || lower.includes("order") || lower.includes("tesco") || lower.includes("amazon")) {
    return {
      intent: "purchase",
      confidence: 0.7,
      complexity: "high",
      tools_needed: ["browser", "vault"],
      recommended_engine: "cloud",
    };
  }

  if (lower.includes("book") || lower.includes("flight") || lower.includes("hotel")) {
    return {
      intent: "booking",
      confidence: 0.7,
      complexity: "high",
      tools_needed: ["browser", "vault"],
      recommended_engine: "cloud",
    };
  }

  if (lower.includes("code") || lower.includes("fix") || lower.includes("bug") || lower.includes("implement")) {
    return {
      intent: "code_complex",
      confidence: 0.5,
      complexity: "medium",
      tools_needed: ["shell", "git"],
      recommended_engine: "cloud",
    };
  }

  if (lower.includes("deploy") || lower.includes("push") || lower.includes("release")) {
    return {
      intent: "deploy",
      confidence: 0.6,
      complexity: "high",
      tools_needed: ["shell", "git"],
      recommended_engine: "cloud",
    };
  }

  // Unknown — send to cloud for safety
  return {
    intent: "unknown",
    confidence: 0.3,
    complexity: "medium",
    tools_needed: [],
    recommended_engine: "cloud",
  };
}
