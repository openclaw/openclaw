/**
 * Quote message parsing module.
 *
 * Extracts quoted messages from cloud_custom_data and formats them as context text.
 */

import type { QuoteInfo, CloudCustomData } from "../../types.js";

// IM client message_type enum (client-defined)
enum ImClientMessageTypeEnum {
  MT_UNKNOW = 0,
  MT_TEXT = 1,
  MT_PIC = 2,
  MT_FILE = 3,
  MT_VIDEO = 4,
  MT_AUDIO = 5,
}

/**
 * Parse quote info from cloud_custom_data JSON string.
 * Returns undefined if no quote exists or parsing fails.
 */
export function parseQuoteFromCloudCustomData(cloudCustomData?: string): QuoteInfo | undefined {
  if (!cloudCustomData) {
    return undefined;
  }

  try {
    const parsed: CloudCustomData = JSON.parse(cloudCustomData);
    if (!parsed.quote || typeof parsed.quote !== "object") {
      return undefined;
    }

    const { quote } = parsed;

    // Support image quotes
    if (Number(quote.type) === (ImClientMessageTypeEnum.MT_PIC as number)) {
      quote.desc = quote.desc?.trim() || "[image]";
    }

    // At least need quote description content to be meaningful
    if (!quote.desc?.trim()) {
      return undefined;
    }

    return quote;
  } catch {
    return undefined;
  }
}

/** Max character length for quote summary */
const QUOTE_DESC_MAX_LENGTH = 500;

/**
 * Format quoted message into context text that can be appended to user messages.
 *
 * Generated format:
 * ```
 * [Quoted message from <sender_nickname>]:
 * <desc (truncated to QUOTE_DESC_MAX_LENGTH)>
 * ---
 * ```
 */
export function formatQuoteContext(quote: QuoteInfo): string {
  let senderPart = "";
  if (quote.sender_nickname) {
    senderPart = ` from ${quote.sender_nickname}`;
  } else if (quote.sender_id) {
    senderPart = ` from ${quote.sender_id}`;
  }

  let desc = quote.desc?.trim() || "";

  // Truncate long quotes to avoid excessive context usage
  if (desc.length > QUOTE_DESC_MAX_LENGTH) {
    desc = `${desc.slice(0, QUOTE_DESC_MAX_LENGTH)}...(truncated)`;
  }

  return `> [Quoted message${senderPart}]:\n>${desc}\n`;
}
