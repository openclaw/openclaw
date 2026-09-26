import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_TEXT_PARAGRAPH_CHARS = 1800;

export function escapeGoogleChatApprovalCardText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildGoogleChatApprovalTextWidget(text: string, format: "text" | "html" = "text") {
  const truncated =
    text.length <= MAX_TEXT_PARAGRAPH_CHARS
      ? text
      : `${truncateUtf16Safe(text, MAX_TEXT_PARAGRAPH_CHARS - 3)}...`;
  return {
    textParagraph: {
      text: format === "html" ? truncated : escapeGoogleChatApprovalCardText(truncated),
    },
  };
}
