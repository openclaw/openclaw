import { normalizeZulipBaseUrl } from "./client.js";

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

export function extractZulipUploadUrls(params: {
  contentHtml: string;
  baseUrl: string;
  max?: number;
}): string[] {
  const base = normalizeZulipBaseUrl(params.baseUrl) ?? params.baseUrl;
  const max = typeof params.max === "number" && params.max > 0 ? Math.floor(params.max) : 10;
  const html = params.contentHtml ?? "";
  if (!html.trim()) {
    return [];
  }

  const candidates: string[] = [];

  // Match absolute URLs.
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+\/user_uploads\/[^\s"'<>]+/gi)) {
    if (match[0]) {
      candidates.push(match[0]);
    }
  }

  // Match relative paths (common in Zulip HTML): /user_uploads/...
  for (const match of html.matchAll(/\/user_uploads\/[^\s"'<>]+/gi)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    try {
      candidates.push(new URL(raw, base).toString());
    } catch {
      // ignore
    }
  }

  return uniq(candidates).slice(0, max);
}
