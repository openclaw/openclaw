/**
 * LLM message classifier.
 * Determines if a message is actionable, needs_review, or skip.
 */

import type { BridgeClient } from "./bridge-client.js";

export type Classification = {
  classification: "actionable" | "needs_review" | "skip";
  confidence: number;
  reasoning: string;
};

export type MessageInput = {
  subject?: string;
  body: string;
  sender_email: string;
  sender_name?: string;
  platform: string;
};

const SYSTEM_PROMPT = `You are a message classifier for a business automation system.
Classify each incoming message into exactly one category:

- "actionable": The message requests a specific change, update, fix, or task that can be executed programmatically (e.g., "update our hours", "fix the typo on the homepage", "add this listing").
- "needs_review": The message might be actionable but is ambiguous, complex, or requires human judgment to interpret (e.g., vague requests, multi-part asks, strategic questions).
- "skip": The message is not actionable — newsletters, notifications, auto-replies, thank-you messages, FYI-only, spam.

Respond with JSON only: {"classification": "...", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;

export async function classifyMessage(
  msg: MessageInput,
  bridge: BridgeClient,
  model: string,
): Promise<Classification> {
  const userPrompt = [
    `Platform: ${msg.platform}`,
    `From: ${msg.sender_name ?? "Unknown"} <${msg.sender_email}>`,
    msg.subject ? `Subject: ${msg.subject}` : null,
    `Body: ${msg.body.slice(0, 2000)}`,
  ].filter(Boolean).join("\n");

  // Call LLM via the bridge's llm-task or use a direct API call.
  // For now, we use a simple fetch to OpenAI since gpt-4o-mini is fast and cheap.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback: treat everything as needs_review if no API key
    return { classification: "needs_review", confidence: 0.5, reasoning: "No classifier API key" };
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const raw = JSON.parse(data.choices[0].message.content);

    return {
      classification: raw.classification ?? "needs_review",
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
      reasoning: raw.reasoning ?? "",
    };
  } catch (err) {
    return {
      classification: "needs_review",
      confidence: 0,
      reasoning: `Classifier error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
