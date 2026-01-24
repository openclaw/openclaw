/**
 * Blocker Detection for Claude Code Sessions
 *
 * Detects when Claude Code encounters a blocker that needs external intervention.
 * Uses pattern matching on assistant messages to identify common blocker scenarios.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { BlockerInfo, SessionEvent } from "./types.js";

const log = createSubsystemLogger("claude-code/blocker-detector");

/**
 * Patterns that indicate Claude Code is waiting for external action.
 * Each pattern has a category and regex patterns to match.
 */
const BLOCKER_PATTERNS: Array<{
  category: string;
  patterns: RegExp[];
  extractors?: Array<{
    field: string;
    pattern: RegExp;
  }>;
}> = [
  {
    category: "waiting_for_user",
    patterns: [
      /let me know when/i,
      /once you['']ve/i,
      /after you['']ve/i,
      /when you['']re ready/i,
      /waiting for you/i,
      /please (complete|finish|do|run|execute|claim|fund)/i,
      /you['']ll need to/i,
      /you need to/i,
      /please let me know/i,
    ],
  },
  {
    category: "funding_needed",
    patterns: [
      /need(s|ed)? (more )?(sol|funds|funding|balance)/i,
      /insufficient (sol|balance|funds)/i,
      /airdrop (failed|rate.?limit)/i,
      /faucet/i,
      /claim (sol|tokens)/i,
    ],
    extractors: [
      { field: "wallet", pattern: /([1-9A-HJ-NP-Za-km-z]{32,44})/ }, // Solana address
      { field: "needed", pattern: /need(?:s|ed)?\s+(\d+(?:\.\d+)?)\s*sol/i },
      { field: "current", pattern: /(?:current|balance)[:\s]+(\d+(?:\.\d+)?)\s*sol/i },
    ],
  },
  {
    category: "external_action",
    patterns: [
      /manual(ly)?/i,
      /browser/i,
      /captcha/i,
      /verification/i,
      /authenticate/i,
      /2fa|two.?factor/i,
    ],
  },
  {
    category: "rate_limited",
    patterns: [
      /rate.?limit/i,
      /too many requests/i,
      /try again (later|in)/i,
      /cooldown/i,
      /quota/i,
    ],
  },
  {
    category: "permission_needed",
    patterns: [
      /permission denied/i,
      /access denied/i,
      /unauthorized/i,
      /need(s)? (permission|access|credentials)/i,
    ],
  },
];

/**
 * Detect if an assistant message indicates a blocker.
 *
 * @param text The assistant message text
 * @param sessionEnded Whether the session just transitioned to done/completed
 * @returns BlockerInfo if blocker detected, undefined otherwise
 */
export function detectBlocker(
  text: string,
  sessionEnded: boolean = false,
): BlockerInfo | undefined {
  if (!text || text.length < 20) return undefined;

  // Skip code blocks and tables to avoid false positives from examples/summaries
  // Remove ``` code blocks
  let cleanText = text.replace(/```[\s\S]*?```/g, "");
  // Remove Markdown tables (lines with |)
  cleanText = cleanText
    .split("\n")
    .filter((line) => !line.trim().startsWith("|") && !line.includes("|---"))
    .join("\n");

  // Use cleaned text for pattern matching
  text = cleanText;

  const matchedPatterns: string[] = [];
  let primaryCategory: string | undefined;
  const extractedContext: Record<string, unknown> = {};

  // Check each pattern category
  for (const { category, patterns, extractors } of BLOCKER_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        matchedPatterns.push(`${category}:${pattern.source}`);
        if (!primaryCategory) {
          primaryCategory = category;
        }

        // Try to extract context
        if (extractors) {
          for (const { field, pattern: extractor } of extractors) {
            const match = text.match(extractor);
            if (match && match[1]) {
              extractedContext[field] = match[1];
            }
          }
        }
      }
    }
  }

  // No patterns matched
  if (matchedPatterns.length === 0) return undefined;

  // For blocker detection to fire, we need strong signals:
  // 1. Session ended with matched patterns (Claude gave up)
  // 2. OR multiple patterns matched (clear blocker situation)
  // 3. OR funding-related (always important)
  const isFundingRelated = primaryCategory === "funding_needed";
  const hasMultipleMatches = matchedPatterns.length >= 2;
  const isStrongSignal = sessionEnded || hasMultipleMatches || isFundingRelated;

  if (!isStrongSignal) {
    log.debug(`Weak blocker signal (patterns: ${matchedPatterns.join(", ")}) - not triggering`);
    return undefined;
  }

  // Extract a reason from the text
  const reason = extractBlockerReason(text, primaryCategory);

  log.info(
    `Blocker detected: category=${primaryCategory}, patterns=${matchedPatterns.length}, reason="${reason.slice(0, 50)}..."`,
  );

  return {
    reason,
    lastMessage: text,
    matchedPatterns,
    extractedContext: Object.keys(extractedContext).length > 0 ? extractedContext : undefined,
  };
}

/**
 * Extract a human-readable reason from the blocker message.
 */
function extractBlockerReason(text: string, category?: string): string {
  // Try to extract the most relevant sentence
  const sentences = text.split(/[.!?\n]+/).filter((s) => s.trim().length > 10);

  // Look for sentences with blocker keywords
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (
      lower.includes("need") ||
      lower.includes("wait") ||
      lower.includes("please") ||
      lower.includes("blocked") ||
      lower.includes("failed")
    ) {
      const trimmed = sentence.trim();
      if (trimmed.length <= 150) {
        return trimmed;
      }
      return trimmed.slice(0, 147) + "...";
    }
  }

  // Fallback: use category-based generic reason
  switch (category) {
    case "funding_needed":
      return "Insufficient funds - need additional SOL";
    case "waiting_for_user":
      return "Waiting for user action";
    case "external_action":
      return "Requires manual/browser action";
    case "rate_limited":
      return "Rate limited - need to wait";
    case "permission_needed":
      return "Permission or access needed";
    default:
      return "Blocked - needs external intervention";
  }
}

/**
 * Check recent events for blocker indicators.
 * Called when session transitions to completed/done state.
 */
export function checkEventsForBlocker(
  events: SessionEvent[],
  lastNEvents: number = 5,
): BlockerInfo | undefined {
  // Get last N assistant messages
  const recentAssistantMessages = events
    .filter((e) => e.type === "assistant_message" && e.text)
    .slice(-lastNEvents);

  // Check each in reverse order (most recent first)
  for (const event of recentAssistantMessages.reverse()) {
    if (!event.text) continue;

    const blocker = detectBlocker(event.text, true);
    if (blocker) {
      return blocker;
    }
  }

  return undefined;
}
