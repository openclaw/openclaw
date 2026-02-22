import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { getCommunityUsecaseCatalog } from "@/lib/community-catalog";

type LessonSource = "reddit" | "twitter" | "github" | "web";

interface LearningLesson {
  id: string;
  title: string;
  source: LessonSource;
  sourceDetail: string;
  rating: number;
  category: string;
  tags: string[];
  summary: string;
  content: string;
  url?: string;
  upvotes?: number;
  fetchedAt: number;
  notified?: boolean;
}

interface FeedSpec {
  url: string;
  source: LessonSource;
  sourceDetail: string;
}

interface ParsedFeedItem {
  title: string;
  link: string;
  summary: string;
  content: string;
  publishedAt: number;
}

interface FeedResult {
  source: LessonSource;
  sourceDetail: string;
  count: number;
  ok: boolean;
  error?: string;
}

interface LessonsResponsePayload {
  lessons: LearningLesson[];
  total: number;
  fetchedAt: string;
  cached: boolean;
  sources: {
    requested: number;
    succeeded: number;
    failed: number;
    details: FeedResult[];
  };
}

const CACHE_TTL_MS = 1000 * 60 * 10;
const FEED_REQUEST_TIMEOUT_MS = 9000;
const MAX_ITEMS_PER_FEED = 6;
const MAX_LESSONS = 48;

const REDDIT_FEEDS: FeedSpec[] = [
  {
    url: "https://www.reddit.com/r/cursor/.rss",
    source: "reddit",
    sourceDetail: "r/cursor",
  },
  {
    url: "https://www.reddit.com/r/ChatGPTCoding/.rss",
    source: "reddit",
    sourceDetail: "r/ChatGPTCoding",
  },
  {
    url: "https://www.reddit.com/r/ClaudeAI/.rss",
    source: "reddit",
    sourceDetail: "r/ClaudeAI",
  },
];

const GITHUB_FEEDS: FeedSpec[] = [
  {
    url: "https://github.blog/changelog/feed/",
    source: "github",
    sourceDetail: "GitHub Changelog",
  },
  {
    url: "https://github.blog/engineering/feed/",
    source: "github",
    sourceDetail: "GitHub Engineering",
  },
];

const DEFAULT_X_FEEDS: FeedSpec[] = [
  {
    url: "https://nitter.net/OpenAI/rss",
    source: "twitter",
    sourceDetail: "X @OpenAI",
  },
  {
    url: "https://nitter.net/AnthropicAI/rss",
    source: "twitter",
    sourceDetail: "X @AnthropicAI",
  },
];

let cache: {
  expiresAt: number;
  payload: LessonsResponsePayload;
} | null = null;

function decodeEntities(value: string): string {
  const withNamedEntities = value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
  return withNamedEntities
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCharCode(parseInt(code, 16))
    );
}

function unwrapCdata(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/i);
  return match ? match[1] : trimmed;
}

function stripHtml(value: string): string {
  return decodeEntities(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeSummary(input: string): string {
  const plain = stripHtml(input);
  if (!plain) {return "No summary available.";}
  return plain.length > 320 ? `${plain.slice(0, 320).trim()}...` : plain;
}

function normalizeContent(input: string, title: string, link: string): string {
  const sourceContent = decodeEntities(input).trim();
  if (sourceContent) {return sourceContent;}
  return `<p>${escapeHtml(title)}</p><p><a href="${escapeHtml(link)}">Open source</a></p>`;
}

function safeDate(input: string | null): number {
  if (!input) {return Date.now();}
  const ts = Date.parse(input);
  return Number.isNaN(ts) ? Date.now() : ts;
}

function hashText(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function parseRssItems(xml: string): ParsedFeedItem[] {
  const items = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi))
    .map((match) => match[0])
    .slice(0, MAX_ITEMS_PER_FEED);

  return items
    .map((item) => {
      const title = decodeEntities(
        unwrapCdata(item.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1] || "")
      );
      const link = decodeEntities(
        unwrapCdata(item.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i)?.[1] || "")
      );
      const description = unwrapCdata(
        item.match(/<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i)?.[1] || ""
      );
      const encoded = unwrapCdata(
        item.match(/<content:encoded(?:\s[^>]*)?>([\s\S]*?)<\/content:encoded>/i)?.[1] ||
          ""
      );
      const pubDate = item.match(/<pubDate(?:\s[^>]*)?>([\s\S]*?)<\/pubDate>/i)?.[1] || null;

      return {
        title,
        link,
        summary: description,
        content: encoded || description,
        publishedAt: safeDate(pubDate),
      };
    })
    .filter((entry) => entry.title && entry.link);
}

function parseAtomEntries(xml: string): ParsedFeedItem[] {
  const entries = Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi))
    .map((match) => match[0])
    .slice(0, MAX_ITEMS_PER_FEED);

  return entries
    .map((entry) => {
      const title = decodeEntities(
        unwrapCdata(entry.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1] || "")
      );
      const summary = unwrapCdata(
        entry.match(/<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i)?.[1] ||
          entry.match(/<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i)?.[1] ||
          ""
      );
      const content = unwrapCdata(
        entry.match(/<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i)?.[1] || summary
      );
      const dateValue =
        unwrapCdata(
          entry.match(/<updated(?:\s[^>]*)?>([\s\S]*?)<\/updated>/i)?.[1] ||
            entry.match(/<published(?:\s[^>]*)?>([\s\S]*?)<\/published>/i)?.[1] ||
            ""
        ) ||
        null;

      const alternateLink =
        entry.match(
          /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i
        )?.[1] ||
        entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)?.[1] ||
        "";

      return {
        title,
        link: decodeEntities(alternateLink.trim()),
        summary,
        content,
        publishedAt: safeDate(dateValue),
      };
    })
    .filter((entry) => entry.title && entry.link);
}

function parseFeed(xml: string): ParsedFeedItem[] {
  if (/<item\b/i.test(xml)) {
    return parseRssItems(xml);
  }
  if (/<entry\b/i.test(xml)) {
    return parseAtomEntries(xml);
  }
  return [];
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/debug|incident|outage|failure|root cause|postmortem/.test(lower)) {
    return "debugging";
  }
  if (/agent|autonomous|assistant|multi-agent/.test(lower)) {
    return "agents";
  }
  if (/prompt|instruction|context window|few-shot/.test(lower)) {
    return "prompting";
  }
  if (/architecture|system design|scalab|pattern|framework/.test(lower)) {
    return "architecture";
  }
  return "workflow";
}

function inferTags(text: string, source: LessonSource): string[] {
  const lower = text.toLowerCase();
  const candidates = [
    "prompting",
    "workflow",
    "agents",
    "architecture",
    "debugging",
    "testing",
    "security",
    "performance",
    "reliability",
    "productivity",
    "deployment",
  ];
  const matched = candidates.filter((candidate) => lower.includes(candidate));
  return Array.from(new Set([source, ...matched])).slice(0, 5);
}

function scoreLesson({
  title,
  summary,
  source,
  publishedAt,
}: {
  title: string;
  summary: string;
  source: LessonSource;
  publishedAt: number;
}): number {
  let score = 68;
  const text = `${title} ${summary}`.toLowerCase();
  const ageHours = Math.max(0, (Date.now() - publishedAt) / (1000 * 60 * 60));

  if (source === "reddit") {score += 7;}
  if (source === "github") {score += 6;}
  if (source === "twitter") {score += 5;}

  if (ageHours <= 24) {score += 8;}
  else if (ageHours <= 24 * 3) {score += 5;}
  else if (ageHours <= 24 * 7) {score += 3;}

  if (/best practice|playbook|guide|checklist|workflow/.test(text)) {score += 8;}
  if (/incident|postmortem|outage|failure/.test(text)) {score += 5;}
  if (/release|changelog|new|launch|update/.test(text)) {score += 4;}
  if (/security|vulnerability|exploit|threat/.test(text)) {score += 5;}

  return Math.max(55, Math.min(98, Math.round(score)));
}

async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "OpenClaw-Mission-Control/1.0 (+LearningHub)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Feed returned ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getXFeedsFromEnv(): FeedSpec[] {
  const configured = process.env.LEARNING_HUB_X_RSS_URLS;
  if (!configured) {return DEFAULT_X_FEEDS;}
  const urls = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length === 0) {return DEFAULT_X_FEEDS;}
  return urls.map((url) => ({
    url,
    source: "twitter",
    sourceDetail: "X custom RSS",
  }));
}

async function loadFeed(spec: FeedSpec): Promise<{
  lessons: LearningLesson[];
  result: FeedResult;
}> {
  try {
    const xml = await fetchFeedXml(spec.url);
    const parsed = parseFeed(xml);
    const lessons: LearningLesson[] = parsed.map((item) => {
      const summary = normalizeSummary(item.summary || item.content);
      const title = item.title.trim();
      const category = inferCategory(`${title} ${summary}`);
      const tags = inferTags(`${title} ${summary}`, spec.source);
      const rating = scoreLesson({
        title,
        summary,
        source: spec.source,
        publishedAt: item.publishedAt,
      });
      const content = normalizeContent(item.content || item.summary, title, item.link);
      const uniqueKey = item.link || `${spec.sourceDetail}:${title}:${item.publishedAt}`;
      return {
        id: `live-${spec.source}-${hashText(uniqueKey)}`,
        title,
        source: spec.source,
        sourceDetail: spec.sourceDetail,
        rating,
        category,
        tags,
        summary,
        content,
        url: item.link,
        fetchedAt: Date.now(),
        notified: false,
      };
    });

    return {
      lessons,
      result: {
        source: spec.source,
        sourceDetail: spec.sourceDetail,
        count: lessons.length,
        ok: true,
      },
    };
  } catch (error) {
    return {
      lessons: [],
      result: {
        source: spec.source,
        sourceDetail: spec.sourceDetail,
        count: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function loadCommunityUsecaseLessons(): {
  lessons: LearningLesson[];
  result: FeedResult;
} {
  try {
    const catalog = getCommunityUsecaseCatalog();
    const lessons: LearningLesson[] = catalog.usecases.map((item) => {
      const title = item.title.trim() || "Community Use Case";
      const summary = normalizeSummary(item.summary || stripHtml(item.content || ""));
      const sourceContent = item.content || item.summary || "";
      const category = item.category || inferCategory(`${title} ${summary}`);
      const tags = item.tags?.length
        ? Array.from(new Set(item.tags)).slice(0, 5)
        : inferTags(`${title} ${summary}`, "web");
      return {
        id: item.id || `community-${hashText(item.sourcePath || title)}`,
        title,
        source: "web",
        sourceDetail: item.sourceDetail || "Community Library",
        rating: Math.max(60, Math.min(98, Number(item.rating) || 78)),
        category,
        tags,
        summary,
        content: normalizeContent(sourceContent, title, item.url || ""),
        url: item.url,
        fetchedAt: Date.now(),
        notified: false,
      };
    });

    return {
      lessons,
      result: {
        source: "web",
        sourceDetail: "Community Use Cases",
        count: lessons.length,
        ok: true,
      },
    };
  } catch (error) {
    return {
      lessons: [],
      result: {
        source: "web",
        sourceDetail: "Community Use Cases",
        count: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function dedupeLessons(lessons: LearningLesson[]): LearningLesson[] {
  const byKey = new Map<string, LearningLesson>();
  for (const lesson of lessons) {
    const key = lesson.url || lesson.id;
    if (!byKey.has(key)) {
      byKey.set(key, lesson);
      continue;
    }
    const existing = byKey.get(key)!;
    if (lesson.rating > existing.rating) {
      byKey.set(key, lesson);
    }
  }
  return Array.from(byKey.values())
    .toSorted((a, b) => b.rating - a.rating)
    .slice(0, MAX_LESSONS);
}

async function buildLessonsPayload(): Promise<LessonsResponsePayload> {
  const feeds = [...REDDIT_FEEDS, ...GITHUB_FEEDS, ...getXFeedsFromEnv()];
  const community = loadCommunityUsecaseLessons();
  const loaded = await Promise.all(feeds.map((feed) => loadFeed(feed)));
  const lessons = dedupeLessons([
    ...community.lessons,
    ...loaded.flatMap((entry) => entry.lessons),
  ]);
  const details = [community.result, ...loaded.map((entry) => entry.result)];

  return {
    lessons,
    total: lessons.length,
    fetchedAt: new Date().toISOString(),
    cached: false,
    sources: {
      requested: feeds.length + 1,
      succeeded: details.filter((detail) => detail.ok).length,
      failed: details.filter((detail) => !detail.ok).length,
      details,
    },
  };
}

// GET /api/learning-hub/lessons
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "1";

    if (!force && cache && cache.expiresAt > Date.now()) {
      return NextResponse.json({
        ...cache.payload,
        cached: true,
      });
    }

    const payload = await buildLessonsPayload();
    cache = {
      payload,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    return NextResponse.json(payload);
  } catch (error) {
    return handleApiError(error, "Failed to fetch live learning lessons");
  }
}, ApiGuardPresets.read);
