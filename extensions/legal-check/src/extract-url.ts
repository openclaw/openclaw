/**
 * Extract the first http(s) URL from free text, mirroring the web UI's
 * extractUrl(form.requirement). When the content carries a link, the backend
 * runs in link mode (crawl the URL); otherwise it runs in content mode (analyze
 * the pasted text). Returns "" when no URL is present.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>）)】]+/i;

export function extractUrl(text: string): string {
  const match = URL_PATTERN.exec(text ?? "");
  if (!match) {
    return "";
  }
  // Trim trailing punctuation a sentence may append right after the URL.
  return match[0].replace(/[.,。，;；!！?？]+$/, "");
}
