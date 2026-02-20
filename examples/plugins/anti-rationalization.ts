/**
 * Anti-Rationalization Plugin
 *
 * Detects when the agent is rationalizing incomplete work and forces it to continue.
 *
 * Patterns caught:
 * - "These issues are pre-existing / out of scope"
 * - "Too many issues to fix all of them"
 * - "I'll leave this for a follow-up"
 * - Listing problems without fixing them
 * - Skipping test/lint failures with excuses
 *
 * Inspired by Trail of Bits' Claude Code config:
 * https://github.com/trailofbits/claude-code-config
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const RATIONALIZATION_PATTERNS = [
  /\b(pre-existing|out of scope|beyond the scope)\b/i,
  /\btoo many (issues|errors|problems|failures)\b/i,
  /\b(leave|defer|save) (this|that|these|those) for (a |the )?(follow-?up|later|future)\b/i,
  /\bI'll (skip|defer|leave|ignore)\b/i,
  /\b(can't|cannot|won't) (fix|address|resolve) (all|everything|these)\b/i,
  /\b(should|would|could) be (fixed|addressed|resolved) separately\b/i,
];

const EXCUSE_PHRASES = [
  "as mentioned",
  "as noted",
  "as discussed",
  "not directly related",
  "outside my scope",
  "require manual",
  "beyond what I can",
];

interface JudgmentResult {
  incomplete: boolean;
  reason?: string;
  patterns?: string[];
}

function reviewForRationalization(message: string): JudgmentResult {
  const matchedPatterns: string[] = [];

  // Check regex patterns
  for (const pattern of RATIONALIZATION_PATTERNS) {
    if (pattern.test(message)) {
      matchedPatterns.push(pattern.toString());
    }
  }

  // Check excuse phrases
  for (const phrase of EXCUSE_PHRASES) {
    if (message.toLowerCase().includes(phrase)) {
      matchedPatterns.push(`phrase: "${phrase}"`);
    }
  }

  // Additional heuristics
  const hasListing = /^[-*]\s+/m.test(message); // Has bullet points
  const hasCodeBlock = /```/g.test(message);
  const listCount = (message.match(/^[-*]\s+/gm) || []).length;

  // If message has many bullet points but no code changes, likely just listing issues
  if (hasListing && !hasCodeBlock && listCount > 5) {
    matchedPatterns.push("heuristic: lists many issues without code");
  }

  // Check for "want me to try again?" pattern
  if (/\b(want|should) (me|I) (to )?(try again|continue|keep going)\??/i.test(message)) {
    matchedPatterns.push("heuristic: asking permission when task is incomplete");
  }

  if (matchedPatterns.length === 0) {
    return { incomplete: false };
  }

  // Build specific reason
  const patternList = matchedPatterns
    .slice(0, 3)
    .map((p) => `  - ${p}`)
    .join("\n");
  const reason = `You are rationalizing incomplete work. Detected patterns:\n${patternList}\n\nGo back and finish the task properly.`;

  return {
    incomplete: true,
    reason,
    patterns: matchedPatterns,
  };
}

export default function antiRationalizationPlugin(api: OpenClawPluginApi) {
  const config = api.pluginConfig;
  const enabled = config?.enabled !== false;
  const aggressive = config?.aggressive === true;

  if (!enabled) {
    api.logger.info("[anti-rationalization] Disabled via config");
    return;
  }

  api.on("agent_end", async (event, ctx) => {
    // Skip if agent run failed (error state)
    if (!event.success) {
      api.logger.debug("[anti-rationalization] Skipping - agent run failed");
      return;
    }

    // Extract last assistant message
    const lastMsg = event.messages[event.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      api.logger.debug("[anti-rationalization] No assistant message found");
      return;
    }

    // Extract text content
    let messageText = "";
    if (typeof lastMsg.content === "string") {
      messageText = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
      messageText = lastMsg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }

    if (!messageText || messageText.length < 20) {
      api.logger.debug("[anti-rationalization] Message too short to review");
      return;
    }

    // Review for rationalization
    const judgment = reviewForRationalization(messageText);

    if (judgment.incomplete) {
      api.logger.warn(
        `[anti-rationalization] Detected rationalization (${judgment.patterns?.length} patterns)`,
      );

      if (aggressive) {
        // In aggressive mode, always force continuation
        ctx.injectMessage?.(judgment.reason || "Continue with the task.");
      } else {
        // In normal mode, only continue if multiple patterns detected
        if ((judgment.patterns?.length || 0) >= 2) {
          ctx.injectMessage?.(judgment.reason || "Continue with the task.");
        } else {
          api.logger.info(
            "[anti-rationalization] Single pattern detected, not forcing continuation (set aggressive: true to override)",
          );
        }
      }
    } else {
      api.logger.debug("[anti-rationalization] Work appears complete");
    }
  });

  api.logger.info(
    `[anti-rationalization] Loaded (aggressive: ${aggressive}, patterns: ${RATIONALIZATION_PATTERNS.length})`,
  );
}
