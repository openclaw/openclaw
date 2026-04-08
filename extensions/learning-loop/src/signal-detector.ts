// ============================================================================
// Signal Detector
//
// Rule-based (no LLM) detection of evolution signals from conversation
// history. Detects execution failures and user corrections that indicate
// a skill should be refined.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export type SignalType = "execution_failure" | "user_correction";

export type EvolutionSignal = {
  type: SignalType;
  section: "Instructions" | "Examples" | "Troubleshooting";
  excerpt: string;
  skillName?: string;
  toolName?: string;
};

type Message = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  name?: string;
};

// ============================================================================
// Detection patterns
// ============================================================================

import { extractMessageText } from "./message-content.js";

const FAILURE_PATTERNS = [
  /\berror\b/i,
  /\bexception\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\btimeout\b/i,
  /\btimed?\s*out\b/i,
  /\bcrash(?:ed|es|ing)?\b/i,
  /\bpanic\b/i,
  /\bfatal\b/i,
  /\baborted?\b/i,
  /\bruntime error\b/i,
  /\bsyntax error\b/i,
  /\btype error\b/i,
  /\breference error\b/i,
  /\bstack trace\b/i,
  /\btraceback\b/i,
  /\bsegfault\b/i,
  /\bcommand not found\b/i,
  /\bbad request\b/i,
  /\bno such file\b/i,
  /\bpermission denied\b/i,
  /\bconnection refused\b/i,
  /\bunavailable\b/i,
  /\boverloaded\b/i,
  /\brate limit(?:ed)?\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bunauthenticated\b/i,
  /\binvalid (?:api key|credentials|token)\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bECONNREFUSED\b/,
  /\bEPIPE\b/,
  /exit code [1-9]\d*/i,
  /status\s*(?:code\s*)?[45]\d{2}/i,
];

const CORRECTION_PATTERNS = [
  // English
  /\bthat'?s?\s+(?:wrong|incorrect)\b/i,
  /\bthat'?s?\s+not\s+(?:right|correct)\b/i,
  /\bno,?\s+(?:that|it|this)\b/i,
  /\byou\s+(?:should|need\s+to|have\s+to|must)\b/i,
  /\bshould\s+(?:be|have|use)\b/i,
  /\binstead,?\s+(?:use|do|try)\b/i,
  /\bactually,?\s+(?:it|you|the|we)\b/i,
  /\bdon'?t\s+(?:do|use|add)\b/i,
  /\bnever\s+(?:do|use|add)\b/i,
  /\balways\s+(?:do|use|add)\b/i,
  /\bplease\s+(?:fix|change|update|correct)\b/i,
  /\bwrong\s+(?:way|approach|method)\b/i,
  /\btry\s+(?:again|this|a\s+different)\b/i,
  /\bnot\s+what\s+I\b/i,
  /\bI\s+(?:said|meant)\b/i,
  /\bstop\s+(?:doing|using|adding)\b/i,
  /\bprefer\s+(?:to|if|that)\b/i,
  /\bplease\s+use\b/i,
  /\bmake\s+sure\s+to\b/i,
  /\b(?:use|prefer)\b.+\brather than\b/i,
];

const ATTRIBUTABLE_ID = String.raw`([a-zA-Z0-9_][a-zA-Z0-9_-]*)`;

// Attribute only from explicit skill references to avoid matching ordinary prose
const SKILL_ATTRIBUTION_PATTERNS = [
  new RegExp(
    String.raw`(?:^|[^a-zA-Z0-9_-])(?:\.agents[\\/])?skills[\\/]${ATTRIBUTABLE_ID}[\\/]SKILL\.md\b`,
    "i",
  ),
  new RegExp(String.raw`\bskill\s+name\s*[:=]\s*["']?${ATTRIBUTABLE_ID}["']?`, "i"),
];

// Attribute only from labeled tool identifiers, not phrases like "tool call failed"
const TOOL_ATTRIBUTION_PATTERNS = [
  new RegExp(String.raw`\btool\s+name\s*[:=]\s*["']?${ATTRIBUTABLE_ID}["']?`, "i"),
  new RegExp(String.raw`\btool\s+call\s*[:=]\s*["']?${ATTRIBUTABLE_ID}["']?`, "i"),
];

// ============================================================================
// Detector
// ============================================================================

export class SignalDetector {
  private processedKeys = new Set<string>();
  private static readonly MAX_PROCESSED = 500;
  private static readonly EXECUTION_FAILURE_ROLES = new Set(["tool", "toolResult", "assistant"]);

  /**
   * Detect evolution signals from a list of messages.
   * Returns deduplicated signals with type, section, and context.
   */
  detect(messages: unknown[]): EvolutionSignal[] {
    const signals: EvolutionSignal[] = [];

    for (const raw of messages) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const msg = raw as Message;
      const text = extractText(msg);
      if (!text) {
        continue;
      }

      // Detect execution failures in tool results and assistant messages
      if (SignalDetector.EXECUTION_FAILURE_ROLES.has(msg.role)) {
        for (const pattern of FAILURE_PATTERNS) {
          if (pattern.test(text)) {
            const signal = this.buildSignal("execution_failure", text, msg);
            if (signal && !this.isDuplicate(signal)) {
              signals.push(signal);
            }
            break; // one signal per message
          }
        }
      }

      // Detect user corrections
      if (msg.role === "user") {
        for (const pattern of CORRECTION_PATTERNS) {
          if (pattern.test(text)) {
            const signal = this.buildSignal("user_correction", text, msg);
            if (signal && !this.isDuplicate(signal)) {
              signals.push(signal);
            }
            break;
          }
        }
      }
    }

    return signals;
  }

  /**
   * Clear processed signal cache. Call at conversation boundaries.
   */
  clearProcessedSignals(): void {
    this.processedKeys.clear();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private buildSignal(type: SignalType, text: string, msg: Message): EvolutionSignal | null {
    // Extract a focused excerpt (context around the match, max 300 chars)
    const excerpt = text.length > 300 ? text.slice(0, 300) + "..." : text;

    // Determine target section based on signal type
    const section: EvolutionSignal["section"] =
      type === "execution_failure" ? "Troubleshooting" : "Instructions";

    // Try to attribute to a skill
    const skillName = extractAttributedId(text, SKILL_ATTRIBUTION_PATTERNS);
    const toolName = extractAttributedId(text, TOOL_ATTRIBUTION_PATTERNS);

    return {
      type,
      section,
      excerpt,
      skillName,
      toolName: toolName ?? msg.name,
    };
  }

  private isDuplicate(signal: EvolutionSignal): boolean {
    // Safety cap: clear if too many tracked signals
    if (this.processedKeys.size > SignalDetector.MAX_PROCESSED) {
      this.processedKeys.clear();
    }

    const key = [
      signal.type,
      signal.skillName ?? "",
      signal.toolName ?? "",
      signal.excerpt.slice(0, 100),
    ].join(":");
    if (this.processedKeys.has(key)) {
      return true;
    }
    this.processedKeys.add(key);
    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function extractText(msg: Message): string {
  return extractMessageText(msg.content);
}

function extractAttributedId(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}
