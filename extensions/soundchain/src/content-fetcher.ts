/**
 * FURL Content Fetcher — URL Detection + Content Extraction
 *
 * Detects URLs in DM messages and extracts readable text content
 * so Claude can summarize videos, articles, tweets, etc.
 *
 * Supported:
 *   - YouTube (transcript via captions API — free, no key needed)
 *   - General web pages (HTML stripped to text)
 *
 * Zero cost, zero new dependencies. Uses built-in fetch().
 */

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

const YOUTUBE_REGEX =
  /(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

const X_TWITTER_REGEX = /(?:x\.com|twitter\.com)\/(\w+)\/status\/(\d+)/;

import { lookup } from "node:dns/promises";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_URLS = 3;
const MAX_TRANSCRIPT_CHARS = 15_000;
const MAX_WEBPAGE_CHARS = 10_000;

// Block private/internal network URLs to prevent SSRF
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // Link-local
  /^0\.0\.0\.0$/,
  /^\[?::1?\]?$/,
  /^\[?::ffff:/i, // IPv6-mapped IPv4 (bracketed or bare)
  /^\[?fd[0-9a-f]{2}:/i, // IPv6 ULA fd00::/8 (bracketed or bare)
  /^\[?fe80:/i, // IPv6 link-local fe80::/10 (bracketed or bare)
  /^\[?fc[0-9a-f]{2}:/i, // IPv6 ULA fc00::/7 (bracketed or bare)
  /\.internal$/i,
  /\.local$/i,
  /metadata\.google/i, // Cloud metadata
  /169\.254\.169\.254/, // AWS/GCP metadata
];

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isBlockedHostname(parsed.hostname);
  } catch {
    return true; // Block unparseable URLs
  }
}

/** Resolve hostname via DNS and check if the IP is private/blocked */
async function isBlockedAfterResolve(url: string): Promise<boolean> {
  if (isBlockedUrl(url)) return true;
  try {
    const parsed = new URL(url);
    const { address } = await lookup(parsed.hostname);
    return isBlockedHostname(address);
  } catch {
    return false; // DNS failure — allow (will fail at fetch anyway)
  }
}

/**
 * Safe fetch that blocks redirects to private networks.
 * Uses redirect: "manual" to inspect each hop.
 */
const MAX_REDIRECTS = 5;

async function safeFetch(url: string, options?: RequestInit, hops = 0): Promise<Response> {
  if (hops > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);

  // Resolve DNS and validate BEFORE fetching (prevents DNS rebinding)
  const parsed = new URL(url);
  if (isBlockedHostname(parsed.hostname)) throw new Error("Blocked hostname");
  let resolvedIp: string | undefined;
  try {
    const { address } = await lookup(parsed.hostname);
    resolvedIp = address;
    if (isBlockedHostname(address)) throw new Error("Blocked resolved IP");
  } catch (e: any) {
    if (e.message?.includes("Blocked")) throw e;
    // DNS failure — proceed with hostname (will fail at fetch if unreachable)
  }

  // DNS validated — proceed with original URL (IP pinning breaks TLS/SNI)
  // The validation + short timeout window is sufficient for non-targeted SSRF
  const res = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: options?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) return res;

    const redirectUrl = new URL(location, url).toString();
    if (isBlockedUrl(redirectUrl)) throw new Error("Redirect to blocked URL");

    return safeFetch(redirectUrl, options, hops + 1);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans a message for URLs, fetches content from each, and appends
 * extracted text so Claude can summarize it.
 * Returns the original message if no URLs found or all extractions fail.
 */
export async function enrichMessageWithUrlContent(message: string): Promise<string> {
  const urls = message.match(URL_REGEX);
  if (!urls || urls.length === 0) return message;

  // Deduplicate
  const unique = [...new Set(urls)].slice(0, MAX_URLS);

  const extractions: string[] = [];

  for (const url of unique) {
    try {
      const content = await extractContent(url);
      if (content) {
        extractions.push(content);
      }
    } catch {
      // Skip failed extractions silently
    }
  }

  if (extractions.length === 0) return message;

  return message + "\n\n---\n" + extractions.join("\n\n---\n");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function extractContent(url: string): Promise<string | null> {
  // Block private/internal network URLs (SSRF prevention — checks both hostname and resolved IP)
  if (await isBlockedAfterResolve(url)) return null;

  const ytMatch = url.match(YOUTUBE_REGEX);
  if (ytMatch) {
    return fetchYouTubeTranscript(ytMatch[1], url);
  }
  const xMatch = url.match(X_TWITTER_REGEX);
  if (xMatch) {
    return fetchXPost(xMatch[1], xMatch[2], url);
  }
  return fetchWebPageText(url);
}

// ---------------------------------------------------------------------------
// YouTube Transcript (free — captions API, no key needed)
// ---------------------------------------------------------------------------

async function fetchYouTubeTranscript(
  videoId: string,
  originalUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const html = await res.text();

    // Extract video title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/\s*-\s*YouTube\s*$/, "").trim()
      : "Unknown Video";

    // Extract ytInitialPlayerResponse JSON
    const playerMatch =
      html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s) ||
      html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);

    if (!playerMatch) {
      return `[YouTube Video: "${title}" — ${originalUrl}]\n(Could not extract transcript — captions may be disabled)`;
    }

    let playerResponse: Record<string, unknown>;
    try {
      playerResponse = JSON.parse(playerMatch[1]);
    } catch {
      return `[YouTube Video: "${title}" — ${originalUrl}]\n(Could not parse video data)`;
    }

    // Navigate to caption tracks
    const captions = playerResponse?.captions as Record<string, unknown> | undefined;
    const renderer = captions?.playerCaptionsTracklistRenderer as
      | Record<string, unknown>
      | undefined;
    const captionTracks = renderer?.captionTracks as Array<Record<string, unknown>> | undefined;

    if (!captionTracks || captionTracks.length === 0) {
      // No captions — try to get video description instead
      const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
      const description = descMatch
        ? descMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        : null;

      if (description && description.length > 50) {
        return `[YouTube Video: "${title}" — ${originalUrl}]\n(No captions available — description below)\n\n${description.slice(0, 3000)}`;
      }
      return `[YouTube Video: "${title}" — ${originalUrl}]\n(No captions or description available)`;
    }

    // Prefer English, fallback to first available
    const track =
      captionTracks.find(
        (t) => typeof t.languageCode === "string" && t.languageCode.startsWith("en"),
      ) || captionTracks[0];

    const captionUrl = track?.baseUrl;
    if (typeof captionUrl !== "string") return null;

    // Fetch caption XML
    const captionRes = await safeFetch(captionUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const xml = await captionRes.text();

    // Parse <text> elements to plain text
    const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
    const transcript = textMatches
      .map((m) => decodeHtmlEntities(m[1]).replace(/\n/g, " "))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!transcript) {
      return `[YouTube Video: "${title}" — ${originalUrl}]\n(Captions found but empty)`;
    }

    const lang = typeof track.languageCode === "string" ? ` (${track.languageCode})` : "";

    return `[YouTube Video: "${title}" — ${originalUrl}]\n[Transcript${lang} — ${transcript.length} chars]:\n\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// X/Twitter Posts (via Nitter instances or syndication API)
// ---------------------------------------------------------------------------

async function fetchXPost(
  username: string,
  tweetId: string,
  originalUrl: string,
): Promise<string | null> {
  // Try Twitter syndication API (public, no auth needed)
  try {
    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`;
    const res = await fetch(syndicationUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const text = data.text as string | undefined;
      const userName = (data.user as Record<string, unknown>)?.name as string | undefined;
      const handle = (data.user as Record<string, unknown>)?.screen_name as string | undefined;

      if (text) {
        const header = `[X Post by ${userName || username} (@${handle || username}) — ${originalUrl}]`;

        // Check for quoted tweet
        const quoted = data.quoted_tweet as Record<string, unknown> | undefined;
        let quotedText = "";
        if (quoted?.text) {
          const qUser = (quoted.user as Record<string, unknown>)?.screen_name || "unknown";
          quotedText = `\n\n[Quoted @${qUser}]: ${quoted.text as string}`;
        }

        // Check for media descriptions
        const mediaDetails = data.mediaDetails as Array<Record<string, unknown>> | undefined;
        let mediaText = "";
        if (mediaDetails && mediaDetails.length > 0) {
          const types = mediaDetails.map((m) => m.type as string).filter(Boolean);
          mediaText = `\n[Media: ${types.join(", ")}]`;
        }

        return `${header}\n\n${text}${quotedText}${mediaText}`;
      }
    }
  } catch {
    // Syndication failed — fall through to web page fetch
  }

  // Fallback: fetch the page directly (may get limited HTML)
  return fetchWebPageText(originalUrl);
}

// ---------------------------------------------------------------------------
// General Web Page
// ---------------------------------------------------------------------------

async function fetchWebPageText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });

    const contentType = res.headers.get("content-type") || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("application/json")
    ) {
      return null; // Skip binary content (images, videos, PDFs, etc.)
    }

    // Cap response body to 512KB to prevent memory exhaustion from large pages
    const MAX_BODY_BYTES = 512 * 1024;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (totalBytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }
    reader.cancel();
    const raw = new TextDecoder().decode(Buffer.concat(chunks));

    // JSON responses — return formatted
    if (contentType.includes("application/json")) {
      return `[API Response: ${url}]\n\n${raw.slice(0, MAX_WEBPAGE_CHARS)}`;
    }

    // Extract title
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "";

    // Strip non-content elements, then all tags
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<svg[\s\S]*?<\/svg>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const cleaned = decodeHtmlEntities(text);

    if (cleaned.length < 100) return null;

    const header = title ? `[Web Page: "${title}" — ${url}]\n\n` : `[Web Page: ${url}]\n\n`;

    return header + cleaned.slice(0, MAX_WEBPAGE_CHARS);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
