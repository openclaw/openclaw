const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gi");

function normalizeTelegramErrorText(value: string): string {
  return value
    .replace(ANSI_SGR_RE, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\\\\r\\\\n/gi, "\n")
    .replace(/\\\\n/gi, "\n")
    .replace(/\\\\r/gi, "\n")
    .replace(/\\\\t/gi, " ")
    .replace(/\\r\\n/gi, "\n")
    .replace(/\\n/gi, "\n")
    .replace(/\\r/gi, "\n")
    .replace(/\\t/gi, " ");
}

export function isTelegramMessageNotModifiedText(text: string): boolean {
  const normalizedText = normalizeTelegramErrorText(text);
  const alphaWords = normalizedText.toLowerCase().replace(/[^a-z]+/g, " ");
  const compactToken = normalizedText.toLowerCase().replace(/[^a-z_]+/g, "");
  return (
    /message\s+is\s+not\s+modified/i.test(normalizedText) ||
    /message_not_modified/i.test(normalizedText) ||
    /\bmessage\b[\s\S]*\bnot\b[\s\S]*\bmodified\b/i.test(alphaWords) ||
    (/\bmessage\b[\s\S]*\bmodified\b/i.test(alphaWords) && /\bnot\b/i.test(alphaWords)) ||
    /specified new message content and reply markup are exactly the same/i.test(normalizedText) ||
    compactToken.includes("messageisnotmodified") ||
    compactToken.includes("messagenotmodified") ||
    compactToken.includes("message_not_modified")
  );
}
