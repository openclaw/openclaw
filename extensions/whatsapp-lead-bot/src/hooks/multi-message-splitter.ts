/**
 * Multi-message splitter - detects and splits agent responses into multiple WhatsApp messages
 *
 * Strategies (in order):
 *
 * 1. Explicit delimiter:
 *    "Message 1\n---MSG---\nMessage 2\n---MSG---\nMessage 3"
 *
 * 2. Paragraph breaks (double+ newlines) - natural separation:
 *    "Message 1\n\n\nMessage 2\n\n\nMessage 3"
 *
 * 3. Long messages with multiple lines:
 *    If message is longer than 500 chars AND has multiple lines,
 *    split by sentence or newline boundaries
 *
 * Returns:
 * - Single message (short or no natural breaks) → returns as-is
 * - Multiple messages → array of individual messages
 */

export interface SplitResult {
  isMulti: boolean;
  messages: string[];
  originalText: string;
  strategy: "delimiter" | "paragraph" | "long-message" | "none";
}

export function splitAgentResponse(text: string): SplitResult {
  if (!text || typeof text !== "string") {
    return { isMulti: false, messages: [text], originalText: text, strategy: "none" };
  }

  // Strategy 1: Explicit delimiter (---MSG---)
  if (text.includes("---MSG---")) {
    const messages = text
      .split("---MSG---")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    if (messages.length > 1) {
      return { isMulti: true, messages, originalText: text, strategy: "delimiter" };
    }
  }

  // Strategy 2: Paragraph breaks (2+ newlines = natural paragraph separator)
  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length > 1) {
    const messages = paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);

    if (messages.length > 1) {
      return { isMulti: true, messages, originalText: text, strategy: "paragraph" };
    }
  }

  // Strategy 3: Long message split by newlines or sentences
  // If the message is long and has natural break points, split it
  if (text.length > 500 && text.includes("\n")) {
    // Split by newlines first
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length >= 2) {
      // Check if individual lines are reasonable WhatsApp message length (< 200 chars)
      const reasonableLengths = lines.every((l) => l.length < 200);
      if (reasonableLengths) {
        return { isMulti: true, messages: lines, originalText: text, strategy: "long-message" };
      }
    }

    // Try splitting by sentence (., !, ?)
    const sentences = text.split(/([.!?])\s+/).reduce<string[]>((acc, part, idx, arr) => {
      if (idx % 2 === 0) {
        // Sentence content
        const sentence = part.trim();
        if (sentence.length > 0) {
          const combined = sentence + (arr[idx + 1] || "");
          acc.push(combined);
        }
      }
      return acc;
    }, []);

    if (sentences.length >= 2) {
      return { isMulti: true, messages: sentences, originalText: text, strategy: "long-message" };
    }
  }

  // No splitting needed
  return { isMulti: false, messages: [text.trim()], originalText: text, strategy: "none" };
}

/**
 * Formats agent response for multi-message delivery
 * Returns a response that instructs the client how to handle multiple messages
 */
export function formatMultiMessageResponse(messages: string[]): {
  text: string;
  messages: string[];
} {
  return {
    text: messages[0], // OpenClaw sends this as the immediate response
    messages: messages, // Plugin receives all messages for sequential sending
  };
}
