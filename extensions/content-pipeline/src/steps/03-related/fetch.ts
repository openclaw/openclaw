/**
 * HTTP fetch + cheerio body extraction for Step 3 (related sources).
 *
 * `extractArticleBody` is pure (HTML in, text out) so it can be unit-tested
 * without touching the network. `fetchFullText` is the network-bound wrapper.
 */
import * as cheerio from "cheerio";
import type { Article, FullArticle } from "../../types.js";

const SELECTOR_LIST = [
  "article",
  "main[role='main']",
  "main",
  "[role='main']",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".article__content",
  ".story-body",
];

const STRIP_SELECTORS = [
  // Non-content elements
  "script",
  "style",
  "nav",
  "aside",
  "header",
  "footer",
  "noscript",
  "form",
  "iframe",
  "figure figcaption",
  // Interactive UI chrome (buttons, share widgets, save buttons)
  "button",
  '[role="button"]',
  '[aria-label*="save" i]',
  '[aria-label*="comment" i]',
  '[aria-label*="share" i]',
  '[aria-label*="bookmark" i]',
  // Common class patterns across CMSes (Wired, Vox, etc.)
  '[class*="SaveButton" i]',
  '[class*="CommentButton" i]',
  '[class*="ShareButton" i]',
  '[class*="BookmarkButton" i]',
  '[class*="CommentLoader" i]',
  '[class*="SocialShare" i]',
  '[class*="NewsletterSignup" i]',
  // Legacy class names
  ".social-share",
  ".newsletter",
  ".share-buttons",
  ".byline-meta",
  ".post-meta",
  ".ad",
  ".advertisement",
];

/**
 * Remove consecutive duplicate short phrases (UI boilerplate leaks).
 *
 * Sites like Wired emit patterns like "Save StorySave this storySave StorySave this story"
 * when multiple save/share buttons share the same label. This pass scans for
 * consecutive repeats of short (<= 40 char) phrases and collapses them.
 *
 * It also strips known Wired-specific leaks that survive the selector strip.
 */
function dedupeBoilerplate(text: string): string {
  // Strip known exact chrome leaks (case-insensitive, global)
  const knownLeaks = [
    /CommentLoaderSave StorySave this story/gi,
    /Save StorySave this story/gi,
    /CommentLoader/gi,
  ];
  let cleaned = text;
  for (const re of knownLeaks) {
    cleaned = cleaned.replace(re, " ");
  }

  // Generic dedup: collapse immediate phrase repeats like "foo bar foo bar" → "foo bar"
  // Matches any 3–40 char run that immediately repeats itself.
  cleaned = cleaned.replace(/(.{3,40}?)\1+/g, "$1");

  // Re-normalize whitespace
  return cleaned.replace(/\s+/g, " ").trim();
}

/** Collapse whitespace runs to single spaces and trim. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pure: extract main article body from HTML using a heuristic selector list.
 *
 * Strategy (first non-empty wins):
 *   1. <article>
 *   2. <main> / [role=main]
 *   3. .post-content / .entry-content / .article-content / .story-body
 *   4. fallback: all <p> tags joined
 *
 * Pre-strips scripts, styles, nav, aside, header, footer, noscript, form,
 * iframe, figure captions, social-share blocks. Caps to `maxChars`.
 */
export function extractArticleBody(html: string, maxChars: number): string {
  const $ = cheerio.load(html);

  // Strip junk first so it doesn't pollute any extracted text
  for (const sel of STRIP_SELECTORS) {
    $(sel).remove();
  }

  // Try semantic selectors in order
  for (const sel of SELECTOR_LIST) {
    const el = $(sel).first();
    if (el.length) {
      const text = dedupeBoilerplate(normalize(el.text()));
      if (text.length >= 200) {
        return text.slice(0, maxChars);
      }
    }
  }

  // Fallback: all paragraphs joined
  const paragraphs: string[] = [];
  $("p").each((_, el) => {
    const t = normalize($(el).text());
    if (t.length >= 20) paragraphs.push(t);
  });

  return dedupeBoilerplate(paragraphs.join(" ")).slice(0, maxChars);
}

/**
 * Fetch the article URL with a 10s timeout and extract the body via
 * `extractArticleBody`. Returns a FullArticle with `fetchOk` flag set.
 *
 * Never throws — always returns the article (with `fetchOk: false` and an
 * `fetchError` message on failure) so callers can decide what to do.
 */
export async function fetchFullText(article: Article, maxChars: number): Promise<FullArticle> {
  const base: FullArticle = {
    ...article,
    fullText: "",
    fetchOk: false,
    keywordMatches: 0, // filled in by the orchestrator
  };

  try {
    const resp = await fetch(article.url, {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
      headers: {
        "User-Agent": "OpenClaw-ContentPipeline/0.1",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!resp.ok) {
      return { ...base, fetchError: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    const fullText = extractArticleBody(html, maxChars);

    if (!fullText) {
      return { ...base, fetchError: "no article body found" };
    }

    return { ...base, fullText, fetchOk: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { ...base, fetchError: msg.slice(0, 120) };
  }
}
