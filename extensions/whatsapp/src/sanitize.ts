const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

// WhatsApp group mentions can appear as opaque internal IDs (e.g. @69771945103584 or @AC8E7CBD...).
// These are not user-meaningful and can make the bot output raw @IDs in group chats.
// Uses lookahead for delimiters instead of \b to catch IDs followed by punctuation.
const RAW_MENTION_ID =
  /@(?:(?:\d{8,})|(?:[0-9a-fA-F]{16,})|(?:[0-9a-fA-F-]{20,}))(?=$|\s|[.,!?;:])/g;

export function sanitizeWhatsAppOutboundText(text: string): string {
  if (!text) {
    return text;
  }

  // 1) Strip standalone message_id hint lines if the model ever outputs them.
  const withoutMessageIdLines = text
    .split(/\r?\n/)
    .filter((line) => !MESSAGE_ID_LINE.test(line))
    .join("\n");

  // 2) Replace raw mention-id tokens.
  return withoutMessageIdLines.replace(RAW_MENTION_ID, "[mention]");
}

export function sanitizeWhatsAppOutboundPoll(poll: {
  question?: string | null;
  options?: Array<string | null>;
  maxSelections?: number;
}): { question: string; options: string[]; maxSelections?: number } {
  return {
    ...poll,
    question: sanitizeWhatsAppOutboundText(String(poll.question ?? "")),
    options: (poll.options ?? []).map((opt) => sanitizeWhatsAppOutboundText(String(opt ?? ""))),
  };
}
