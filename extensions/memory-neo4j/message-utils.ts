/**
 * Message extraction utilities for the memory pipeline.
 *
 * Extracts and cleans user/assistant messages from the raw event.messages
 * array, stripping channel wrappers, injected context, tool output, and
 * other noise so downstream consumers (attention gate, memory store) see
 * only the substantive text.
 */

// ============================================================================
// Core Extraction
// ============================================================================

/**
 * Extract text blocks from messages with a given role, apply a strip function,
 * and filter out short results. Handles both string content and content block arrays.
 */
function extractMessagesByRole(
  messages: unknown[],
  role: string,
  stripFn: (text: string) => string,
): string[] {
  const texts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;

    if (msgObj.role !== role) {
      continue;
    }

    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }

  return texts.map(stripFn).filter((t) => t.length >= 10);
}

// ============================================================================
// User Message Extraction
// ============================================================================

/**
 * Extract user message texts from the event.messages array.
 */
export function extractUserMessages(messages: unknown[]): string[] {
  return extractMessagesByRole(messages, "user", stripMessageWrappers);
}

/**
 * Strip injected context, channel metadata wrappers, and system prefixes
 * so the attention gate sees only the raw user text.
 * Exported for use by the cleanup command.
 */
export function stripMessageWrappers(text: string): string {
  let s = text;
  // Injected context from memory system
  s = s.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "");
  s = s.replace(/<core-memory-refresh>[\s\S]*?<\/core-memory-refresh>\s*/g, "");
  s = s.replace(/<system>[\s\S]*?<\/system>\s*/g, "");
  // File attachments (PDFs, images, etc. forwarded inline by channels)
  s = s.replace(/<file\b[^>]*>[\s\S]*?<\/file>\s*/g, "");
  // Media attachment preamble (appears before Telegram wrapper)
  s = s.replace(/^\[media attached:[^\]]*\]\s*(?:To send an image[^\n]*\n?)*/i, "");
  // System exec output blocks (may appear before Telegram wrapper)
  s = s.replace(/^(?:System:\s*\[[^\]]*\][^\n]*\n?)+/gi, "");
  // Voice chat timestamp prefix: [Tue 2026-02-10 19:41 GMT+8]
  s = s.replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/i,
    "",
  );
  // Conversation info metadata block (gateway routing context with JSON code fence)
  s = s.replace(/Conversation info\s*\(untrusted metadata\):\s*```[\s\S]*?```\s*/g, "");
  // Queued message batch header and separators
  s = s.replace(/^\[Queued messages while agent was busy\]\s*/i, "");
  s = s.replace(/---\s*Queued #\d+\s*/g, "");
  // Telegram wrapper — may now be at start after previous strips
  s = s.replace(/^\s*\[Telegram\s[^\]]+\]\s*/i, "");
  // "[message_id: ...]" suffix (Telegram and other channel IDs)
  s = s.replace(/\n?\[message_id:\s*[^\]]+\]\s*$/i, "");
  // Slack wrapper — "[Slack <workspace> #channel @user] MESSAGE [slack message id: ...]"
  s = s.replace(/^\s*\[Slack\s[^\]]+\]\s*/i, "");
  s = s.replace(/\n?\[slack message id:\s*[^\]]*\]\s*$/i, "");
  return s.trim();
}

// ============================================================================
// Assistant Message Extraction
// ============================================================================

/**
 * Strip tool-use, thinking, and code-output blocks from assistant messages
 * so the attention gate sees only the substantive assistant text.
 */
export function stripAssistantWrappers(text: string): string {
  let s = text;
  // Tool-use / tool-result / function_call blocks
  s = s.replace(/<tool_use>[\s\S]*?<\/tool_use>\s*/g, "");
  s = s.replace(/<tool_result>[\s\S]*?<\/tool_result>\s*/g, "");
  s = s.replace(/<function_call>[\s\S]*?<\/function_call>\s*/g, "");
  // Thinking tags
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "");
  s = s.replace(/<antThinking>[\s\S]*?<\/antThinking>\s*/g, "");
  // Code execution output
  s = s.replace(/<code_output>[\s\S]*?<\/code_output>\s*/g, "");
  return s.trim();
}

/**
 * Extract assistant message texts from the event.messages array.
 */
export function extractAssistantMessages(messages: unknown[]): string[] {
  return extractMessagesByRole(messages, "assistant", stripAssistantWrappers);
}
