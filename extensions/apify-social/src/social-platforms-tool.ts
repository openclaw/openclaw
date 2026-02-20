import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam, stringEnum } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  ToolInputError,
  normalizeCacheKey,
  normalizeSecretInput,
  readCache,
  readResponseText,
  readStringArrayParam,
  resolveCacheTtlMs,
  withTimeout,
  wrapExternalContent,
  writeCache,
} from "./util.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOCIAL_PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"] as const;
type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

const INSTAGRAM_MODES = ["url", "search"] as const;
const INSTAGRAM_URL_TYPES = ["posts", "comments", "mentions", "urls"] as const;
const INSTAGRAM_SEARCH_TYPES = ["hashtags", "places", "users"] as const;
const TIKTOK_TYPES = ["search", "hashtags", "videos", "profiles"] as const;

const DEFAULT_APIFY_BASE_URL = "https://api.apify.com";
const ALLOWED_APIFY_BASE_URL_PREFIX = "https://api.apify.com";
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULT_CHARS = 50_000;
const HTTP_TIMEOUT_MS = 30_000;

const LINKEDIN_ACTIONS = ["profiles", "company", "jobs"] as const;
type LinkedinAction = (typeof LINKEDIN_ACTIONS)[number];

const LINKEDIN_RUN_TYPES = ["profiles", "company_details", "company_posts", "jobs"] as const;
type LinkedinRunType = (typeof LINKEDIN_RUN_TYPES)[number];

const ACTOR_IDS: Record<string, string> = {
  instagram: "shu8hvrXbJbY3Eb9W",
  tiktok: "GdWCkxBtKWOsKjdch",
  youtube: "h7sDV53CddomktSi5",
  linkedin_profiles: "GOvL4O4RwFqsdIqXF",
  linkedin_company_details: "AjfNXEI9qTA2IdaAX",
  linkedin_company_posts: "eUv8d0ndjClMLtT1B",
  linkedin_jobs: "hKByXkMQaC5Qt9UMN",
};

const SOCIAL_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RequestSchema = Type.Object({
  platform: stringEnum(SOCIAL_PLATFORMS, {
    description: "Social media platform to scrape.",
  }),
  instagramMode: Type.Optional(
    stringEnum(INSTAGRAM_MODES, {
      description: "Instagram: 'url' to scrape direct URLs, 'search' to search by query.",
    }),
  ),
  instagramType: Type.Optional(
    stringEnum([...INSTAGRAM_URL_TYPES, ...INSTAGRAM_SEARCH_TYPES] as const, {
      description:
        "Instagram data type. URL mode: posts, comments, mentions, urls. Search mode: hashtags, places, users.",
    }),
  ),
  tiktokType: Type.Optional(
    stringEnum(TIKTOK_TYPES, {
      description: "TikTok input type: search queries, hashtags, video URLs, or profiles.",
    }),
  ),
  linkedinAction: Type.Optional(
    stringEnum(LINKEDIN_ACTIONS, {
      description:
        "LinkedIn action: profiles (profile details), company (details + optionally posts), or jobs.",
    }),
  ),
  includePosts: Type.Optional(
    Type.Boolean({
      description:
        "LinkedIn company action: also scrape company posts alongside details (default: true).",
    }),
  ),
  companyPostLimit: Type.Optional(
    Type.Number({
      description:
        "LinkedIn company action: max posts to scrape per company when includePosts is true (1-100, default: uses maxResults).",
      minimum: 1,
      maximum: 100,
    }),
  ),
  urls: Type.Optional(
    Type.Array(Type.String(), {
      description: "URLs to scrape (Instagram, TikTok, YouTube, or LinkedIn URLs).",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Search terms (Instagram search, TikTok search, YouTube search, LinkedIn company names).",
    }),
  ),
  hashtags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Hashtags to scrape (TikTok).",
    }),
  ),
  profiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "Profile usernames/handles (TikTok or LinkedIn — without @).",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 20).",
      minimum: 1,
      maximum: 100,
    }),
  ),
  actorInput: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Additional platform-specific Actor input parameters merged into the Actor input. " +
        "Use this to fine-tune scraping behavior (filters, downloads, sorting, etc.). " +
        "See platform-specific options in the tool description.",
    }),
  ),
});

const RunRefSchema = Type.Object({
  runId: Type.String({ description: "Apify run ID from start response." }),
  platform: stringEnum(SOCIAL_PLATFORMS, { description: "Platform of this run." }),
  datasetId: Type.String({ description: "Dataset ID from start response." }),
  linkedinAction: Type.Optional(
    stringEnum(LINKEDIN_RUN_TYPES, { description: "LinkedIn run type (for LinkedIn runs)." }),
  ),
});

const SocialPlatformsSchema = Type.Object({
  action: stringEnum(["start", "collect"] as const, {
    description:
      "'start': fire off scraping jobs concurrently, returns immediately with run IDs. " +
      "'collect': fetch results for previously started runs.",
  }),
  requests: Type.Optional(
    Type.Array(RequestSchema, {
      description:
        "Scraping requests (for 'start' action). Each specifies a platform and its parameters.",
    }),
  ),
  runs: Type.Optional(
    Type.Array(RunRefSchema, {
      description: "Run references from 'start' response (for 'collect' action).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Plugin config resolution
// ---------------------------------------------------------------------------

interface SocialPluginConfig {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  cacheTtlMinutes?: number;
  maxResults?: number;
  allowedPlatforms?: string[];
}

function parsePluginConfig(raw?: Record<string, unknown>): SocialPluginConfig {
  if (!raw) return {};
  return raw as SocialPluginConfig;
}

function resolveSocialApiKey(config: SocialPluginConfig): string | undefined {
  const fromConfig = typeof config.apiKey === "string" ? normalizeSecretInput(config.apiKey) : "";
  const fromEnv = normalizeSecretInput(process.env.APIFY_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveSocialEnabled(params: { config: SocialPluginConfig; apiKey?: string }): boolean {
  if (typeof params.config.enabled === "boolean") {
    return params.config.enabled;
  }
  return Boolean(params.apiKey);
}

function resolveSocialBaseUrl(config: SocialPluginConfig): string {
  const raw = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  const url = raw || DEFAULT_APIFY_BASE_URL;
  if (!url.startsWith(ALLOWED_APIFY_BASE_URL_PREFIX)) {
    throw new Error(
      `Invalid Apify base URL: "${url}". Must start with "${ALLOWED_APIFY_BASE_URL_PREFIX}".`,
    );
  }
  return url;
}

function resolveAllowedPlatforms(config: SocialPluginConfig): Set<SocialPlatform> {
  const list = config.allowedPlatforms;
  if (Array.isArray(list) && list.length > 0) {
    return new Set(list.filter((p): p is SocialPlatform => SOCIAL_PLATFORMS.includes(p as never)));
  }
  return new Set(SOCIAL_PLATFORMS);
}

function resolveMaxResults(config: SocialPluginConfig): number {
  const raw = config.maxResults;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(100, Math.floor(raw));
  }
  return DEFAULT_MAX_RESULTS;
}

// ---------------------------------------------------------------------------
// Unified platform handler interface
// ---------------------------------------------------------------------------

interface PreparedRun {
  actorId: string;
  input: Record<string, unknown>;
  runType?: string;
}

interface CommonParams {
  urls?: string[];
  queries?: string[];
  hashtags?: string[];
  profiles?: string[];
  maxResults: number;
}

interface PlatformHandler {
  prepare(req: Record<string, unknown>, common: CommonParams): PreparedRun[];
  format(item: Record<string, unknown>, runType?: string): string;
}

const HANDLERS: Record<SocialPlatform, PlatformHandler> = {
  instagram: {
    prepare(req, common) {
      const mode = readStringParam(req, "instagramMode", { required: true });
      const type = readStringParam(req, "instagramType", { required: true });
      if (mode === "url") {
        if (!common.urls?.length) {
          throw new ToolInputError("Instagram URL mode requires 'urls' parameter.");
        }
        return [
          {
            actorId: ACTOR_IDS.instagram,
            input: {
              directUrls: common.urls,
              resultsType: type === "urls" ? "posts" : type,
              resultsLimit: common.maxResults,
            },
          },
        ];
      }
      if (!common.queries?.length) {
        throw new ToolInputError("Instagram search mode requires 'queries' parameter.");
      }
      return common.queries.map((query) => ({
        actorId: ACTOR_IDS.instagram,
        input: {
          search: query,
          searchType: type,
          searchLimit: common.maxResults,
          resultsType: type,
          resultsLimit: common.maxResults,
        },
      }));
    },
    format: formatInstagramItem,
  },

  tiktok: {
    prepare(req, common) {
      const type = readStringParam(req, "tiktokType", { required: true });
      const base = {
        resultsPerPage: common.maxResults,
        shouldDownloadVideos: false,
        shouldDownloadSubtitles: false,
        shouldDownloadCovers: false,
        shouldDownloadAvatars: false,
        shouldDownloadSlideshowImages: false,
        shouldDownloadMusicCovers: false,
      };
      switch (type) {
        case "search":
          if (!common.queries?.length) {
            throw new ToolInputError("TikTok search requires 'queries' parameter.");
          }
          return [{ actorId: ACTOR_IDS.tiktok, input: { ...base, searchQueries: common.queries } }];
        case "hashtags":
          if (!common.hashtags?.length) {
            throw new ToolInputError("TikTok hashtags requires 'hashtags' parameter.");
          }
          return [{ actorId: ACTOR_IDS.tiktok, input: { ...base, hashtags: common.hashtags } }];
        case "videos":
          if (!common.urls?.length) {
            throw new ToolInputError("TikTok videos requires 'urls' parameter.");
          }
          return [{ actorId: ACTOR_IDS.tiktok, input: { ...base, videoUrls: common.urls } }];
        case "profiles":
          if (!common.profiles?.length) {
            throw new ToolInputError("TikTok profiles requires 'profiles' parameter.");
          }
          return [
            {
              actorId: ACTOR_IDS.tiktok,
              input: { ...base, profiles: common.profiles, profileScrapeSections: ["videos"] },
            },
          ];
        default:
          throw new ToolInputError(`Unknown TikTok type: ${type}`);
      }
    },
    format: formatTiktokItem,
  },

  youtube: {
    prepare(_req, common) {
      if (common.urls?.length) {
        return [
          {
            actorId: ACTOR_IDS.youtube,
            input: {
              startUrls: common.urls.map((url) => ({ url })),
              maxResults: common.maxResults,
            },
          },
        ];
      }
      if (common.queries?.length) {
        return [
          {
            actorId: ACTOR_IDS.youtube,
            input: { searchKeywords: common.queries.join(", "), maxResults: common.maxResults },
          },
        ];
      }
      throw new ToolInputError("YouTube requires 'urls' or 'queries' parameter.");
    },
    format: formatYoutubeItem,
  },

  linkedin: {
    prepare(req, common) {
      const action = readStringParam(req, "linkedinAction", { required: true }) as LinkedinAction;
      const includePosts = req.includePosts !== false;

      switch (action) {
        case "profiles": {
          const usernames = [...(common.urls ?? []), ...(common.profiles ?? [])];
          if (!usernames.length) {
            throw new ToolInputError(
              "LinkedIn profiles action requires 'urls' (profile URLs) or 'profiles' (usernames).",
            );
          }
          return [
            { actorId: ACTOR_IDS.linkedin_profiles, input: { usernames }, runType: "profiles" },
          ];
        }
        case "company": {
          if (!common.urls?.length) {
            throw new ToolInputError(
              "LinkedIn company action requires 'urls' (LinkedIn company profile URLs).",
            );
          }
          const companyPostLimit = readNumberParam(req, "companyPostLimit");
          const runs: PreparedRun[] = [
            {
              actorId: ACTOR_IDS.linkedin_company_details,
              input: { profileUrls: common.urls },
              runType: "company_details",
            },
          ];
          if (includePosts) {
            runs.push({
              actorId: ACTOR_IDS.linkedin_company_posts,
              input: {
                company_names: common.urls,
                limit: companyPostLimit ?? Math.min(common.maxResults, 100),
              },
              runType: "company_posts",
            });
          }
          return runs;
        }
        case "jobs": {
          if (!common.urls?.length) {
            throw new ToolInputError(
              "LinkedIn jobs action requires 'urls' (LinkedIn jobs search URLs).",
            );
          }
          return [
            { actorId: ACTOR_IDS.linkedin_jobs, input: { urls: common.urls }, runType: "jobs" },
          ];
        }
        default:
          throw new ToolInputError(`Unknown LinkedIn action: ${String(action)}`);
      }
    },
    format(item, runType) {
      switch (runType) {
        case "profiles":
          return formatLinkedInProfileItem(item);
        case "company_details":
          return formatLinkedInCompanyItem(item);
        case "company_posts":
          return formatLinkedInPostItem(item);
        case "jobs":
          return formatLinkedInJobItem(item);
        default:
          return `\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``;
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Apify async API helpers
// ---------------------------------------------------------------------------

interface ApifyRunInfo {
  id: string;
  defaultDatasetId: string;
  status: string;
}

async function apifyFetch<T>(params: {
  method?: string;
  path: string;
  apiKey: string;
  baseUrl: string;
  body?: Record<string, unknown>;
  errorPrefix: string;
}): Promise<T> {
  const res = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      ...(params.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${params.apiKey}`,
      "x-apify-integration-platform": "openclaw",
      "x-apify-integration-ai-tool": "true",
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
    signal: withTimeout(undefined, HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(`${params.errorPrefix} (${res.status}): ${detail.text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function startApifyActorRun(params: {
  actorId: string;
  input: Record<string, unknown>;
  apiKey: string;
  baseUrl: string;
}): Promise<ApifyRunInfo> {
  const result = await apifyFetch<{ data: ApifyRunInfo }>({
    method: "POST",
    path: `/v2/acts/${params.actorId}/runs`,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    body: params.input,
    errorPrefix: "Failed to start Apify actor",
  });
  return result.data;
}

async function getApifyRunStatus(params: {
  runId: string;
  apiKey: string;
  baseUrl: string;
}): Promise<{ status: string; defaultDatasetId: string }> {
  const result = await apifyFetch<{ data: { status: string; defaultDatasetId: string } }>({
    path: `/v2/actor-runs/${params.runId}`,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    errorPrefix: "Failed to get run status",
  });
  return result.data;
}

async function getApifyDatasetItems(params: {
  datasetId: string;
  apiKey: string;
  baseUrl: string;
}): Promise<unknown[]> {
  return apifyFetch<unknown[]>({
    path: `/v2/datasets/${params.datasetId}/items`,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    errorPrefix: "Failed to get dataset items",
  });
}

// ---------------------------------------------------------------------------
// Result formatters
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value as string | number | boolean);
}

function num(value: unknown): string {
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  return str(value);
}

function rawDataBlock(data: unknown): string {
  return `\n<details><summary>Raw data</summary>\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n</details>`;
}

function formatStats(entries: [string, unknown][]): string | null {
  const parts = entries
    .filter(([, v]) => v !== undefined)
    .map(([label, v]) => `${label}: ${num(v)}`);
  return parts.length ? `**${parts.join(" | ")}**` : null;
}

function pushField(lines: string[], label: string, ...values: unknown[]): void {
  const val = values.find((v) => v !== undefined && v !== null && v !== "");
  if (val !== undefined) {
    lines.push(`**${label}**: ${str(val)}`);
  }
}

function pushNumField(lines: string[], label: string, ...values: unknown[]): void {
  const val = values.find((v) => v !== undefined && v !== null);
  if (val !== undefined) {
    lines.push(`**${label}**: ${num(val)}`);
  }
}

function formatInstagramItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## Instagram Post by @${str(item.ownerUsername)}`];
  pushField(lines, "URL", item.url);
  pushField(lines, "Type", item.type);
  const stats = formatStats([
    ["Likes", item.likesCount],
    ["Comments", item.commentsCount],
  ]);
  if (stats) {
    lines.push(stats);
  }
  pushField(lines, "Caption", item.caption);
  pushField(lines, "Posted", item.timestamp);
  lines.push(rawDataBlock(item));
  return lines.join("\n");
}

function formatTiktokItem(item: Record<string, unknown>): string {
  const author =
    item.authorMeta && typeof item.authorMeta === "object"
      ? (item.authorMeta as Record<string, unknown>).name
      : item.author;
  const lines: string[] = [`## TikTok Video by @${str(author)}`];
  pushField(lines, "URL", item.webVideoUrl);
  const stats = formatStats([
    ["Plays", item.playCount],
    ["Likes", item.diggCount],
    ["Shares", item.shareCount],
    ["Comments", item.commentCount],
  ]);
  if (stats) {
    lines.push(stats);
  }
  pushField(lines, "Description", item.text);
  const videoMeta = item.videoMeta as Record<string, unknown> | undefined;
  if (videoMeta?.duration) {
    lines.push(`**Duration**: ${num(videoMeta.duration)}s`);
  }
  pushField(lines, "Posted", item.createTimeISO);
  lines.push(rawDataBlock(item));
  return lines.join("\n");
}

function formatYoutubeItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## ${str(item.title)}`];
  pushField(lines, "URL", item.url);
  if (item.channelName) {
    const subs = item.numberOfSubscribers ? ` (${num(item.numberOfSubscribers)} subscribers)` : "";
    lines.push(`**Channel**: ${str(item.channelName)}${subs}`);
  }
  const stats = formatStats([
    ["Views", item.viewCount],
    ["Likes", item.likes],
  ]);
  if (stats) {
    lines.push(stats);
  }
  pushField(lines, "Duration", item.duration);
  pushField(lines, "Published", item.date);
  pushField(lines, "Description", item.text);
  lines.push(rawDataBlock(item));
  return lines.join("\n");
}

function formatLinkedInProfileItem(item: Record<string, unknown>): string {
  if (item.results && typeof item.results === "object") {
    const results = item.results as Record<string, Record<string, unknown>>;
    const parts: string[] = [];
    for (const [username, profile] of Object.entries(results)) {
      const lines: string[] = [`## LinkedIn Profile: ${username}`];
      const basicInfo = profile.basic_info as Record<string, unknown> | undefined;
      if (basicInfo?.location && typeof basicInfo.location === "object") {
        const loc = basicInfo.location as Record<string, unknown>;
        lines.push(`**Location**: ${str(loc.full || loc.city || loc.country)}`);
      }
      const experience = profile.experience as Record<string, unknown>[] | undefined;
      if (experience?.length) {
        lines.push("**Experience**:");
        for (const exp of experience.slice(0, 5)) {
          lines.push(`  - ${str(exp.title)} at ${str(exp.company)} (${str(exp.duration)})`);
        }
      }
      const education = profile.education as Record<string, unknown>[] | undefined;
      if (education?.length) {
        lines.push("**Education**:");
        for (const edu of education.slice(0, 3)) {
          lines.push(`  - ${str(edu.school)} — ${str(edu.degree)}`);
        }
      }
      lines.push(rawDataBlock(profile));
      parts.push(lines.join("\n"));
    }
    const failed = item.failedUsernames as string[] | undefined;
    if (failed?.length) {
      parts.push(`**Failed usernames**: ${failed.join(", ")}`);
    }
    return parts.join("\n\n---\n\n");
  }
  return `\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``;
}

function formatLinkedInCompanyItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## LinkedIn Company: ${str(item.name || item.companyName)}`];
  pushField(lines, "Industry", item.industry);
  pushField(lines, "Website", item.website);
  pushNumField(lines, "Employees", item.employeesCount, item.staffCount);
  pushField(lines, "Description", item.description);
  pushField(lines, "Specialities", item.specialities);
  pushField(lines, "Founded", item.foundedYear, item.founded);
  pushField(lines, "Headquarters", item.headquarters);
  pushNumField(lines, "Followers", item.followerCount, item.followersCount);
  pushField(lines, "LinkedIn", item.linkedinUrl, item.url);
  lines.push(rawDataBlock(item));
  return lines.join("\n");
}

function formatLinkedInPostItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## LinkedIn Post`];
  pushField(lines, "Company", item.company, item.companyName);
  pushField(lines, "URL", item.postUrl, item.url);
  const stats = formatStats([
    ["Reactions", item.totalReactionCount],
    ["Comments", item.commentsCount],
  ]);
  if (stats) {
    lines.push(stats);
  }
  pushField(lines, "Content", item.text, item.content);
  pushField(lines, "Posted", item.postedAt, item.publishedAt);
  lines.push(rawDataBlock(item));
  return lines.join("\n");
}

function formatLinkedInJobItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## ${str(item.title)}`];
  pushField(lines, "Company", item.companyName);
  pushField(lines, "Location", item.location);
  pushField(lines, "URL", item.link);
  if (Array.isArray(item.salaryInfo) && item.salaryInfo.length) {
    lines.push(`**Salary**: ${(item.salaryInfo as string[]).join(" - ")}`);
  }
  pushField(lines, "Type", item.employmentType);
  pushField(lines, "Level", item.seniorityLevel);
  pushField(lines, "Posted", item.postedAt);
  pushField(lines, "Applicants", item.applicantsCount);
  if (item.descriptionText) {
    const desc = str(item.descriptionText);
    lines.push(`**Description**: ${desc.length > 500 ? desc.slice(0, 500) + "…" : desc}`);
  }
  lines.push(rawDataBlock(item));
  return lines.join("\n");
}

function formatPlatformResults(
  platform: SocialPlatform,
  items: unknown[],
  linkedinRunType?: LinkedinRunType,
): string {
  const handler = HANDLERS[platform];
  const parts = items.map((item) => {
    try {
      return handler.format(item as Record<string, unknown>, linkedinRunType);
    } catch {
      return `## [unreadable item]\n${JSON.stringify(item).slice(0, 200)}`;
    }
  });

  const text = parts.join("\n\n---\n\n");
  if (text.length > MAX_RESULT_CHARS) {
    return text.slice(0, MAX_RESULT_CHARS) + "\n\n[…truncated]";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tool description builder
// ---------------------------------------------------------------------------

function buildToolDescription(allowed: Set<SocialPlatform>): string {
  const lines = [
    "Scrape structured data from social media platforms via Apify.",
    "Always prefer this tool over web_fetch for Instagram, TikTok, YouTube, and LinkedIn data.",
    "",
    "TWO-PHASE ASYNC PATTERN:",
    '1. Call with action="start" and a requests array → fires off all scraping jobs concurrently, returns immediately with run IDs.',
    "2. Do other work (reasoning, other tool calls, etc.).",
    '3. Call with action="collect" and the runs array from step 1 → fetches results for completed runs, reports pending ones.',
    "",
    "START ACTION:",
    '  action: "start"',
    "  requests: array of request objects (one per scraping job, no limit per platform). Each request has:",
    '    - platform (required): "instagram" | "tiktok" | "youtube" | "linkedin"',
    "    - platform-specific parameters (see below)",
    "    - maxResults (optional, 1-100, default 20)",
    "",
    "COLLECT ACTION:",
    '  action: "collect"',
    "  runs: array of { runId, platform, datasetId, linkedinAction? } objects from the start response.",
    "  Returns completed results + lists any still-pending runs. Call again if runs are pending.",
    "",
  ];

  if (allowed.has("instagram")) {
    lines.push(
      'INSTAGRAM (platform="instagram"):',
      "  Requires: instagramMode + instagramType.",
      '  Mode "url" — scrape direct Instagram URLs:',
      "    instagramType: posts | comments | mentions | urls",
      "    Requires: urls (array of Instagram post/profile/reel URLs)",
      '  Mode "search" — search Instagram by keyword:',
      "    instagramType: hashtags | places | users",
      "    Requires: queries (array of search terms — fires one run per query)",
      "  actorInput options for Instagram:",
      "    resultsType: string — what to scrape: posts | comments | details | mentions | reels (default: posts)",
      "    resultsLimit: number — max results per URL (default: 200)",
      '    onlyPostsNewerThan: string — date filter, e.g. "2024-01-01" or "7 days"',
      "    searchType: string — search type: user | hashtag | place (default: hashtag)",
      "    searchLimit: number — max search results (1-250, default: 1)",
      "    addParentData: boolean — add source metadata to results (default: false)",
      "",
    );
  }

  if (allowed.has("tiktok")) {
    lines.push(
      'TIKTOK (platform="tiktok"):',
      "  Requires: tiktokType + the matching input array.",
      '  tiktokType="search"   → requires queries',
      '  tiktokType="hashtags" → requires hashtags (without # prefix)',
      '  tiktokType="videos"   → requires urls (TikTok video URLs)',
      '  tiktokType="profiles" → requires profiles (usernames without @)',
      "  actorInput options for TikTok:",
      "    resultsPerPage: number — results per hashtag/profile/search (1-1000000, default: 100)",
      "    profileScrapeSections: string[] — sections to scrape: videos | reposts (default: [videos])",
      "    profileSorting: string — sort profile content: latest | popular | oldest (default: latest)",
      "    excludePinnedPosts: boolean — exclude pinned posts from profiles (default: false)",
      '    oldestPostDateUnified: string — date filter for profile videos, e.g. "2024-01-01" or "30 days"',
      '    newestPostDate: string — scrape videos published before this date, e.g. "2025-01-01"',
      "    leastDiggs: number — min hearts filter (popularity filter)",
      "    mostDiggs: number — max hearts filter (popularity filter)",
      '    searchSection: string — filter search results: "" (Top) | "/video" (Video) | "/user" (Profile)',
      "    maxProfilesPerQuery: number — max profiles for profile searches (default: 10)",
      '    searchSorting: string — sort search results: "0" (relevant) | "1" (most liked) | "3" (latest)',
      '    searchDatePosted: string — search date range: "0" (all time) | "1" (24h) | "2" (week) | "3" (month) | "4" (3 months) | "5" (6 months)',
      "    scrapeRelatedVideos: boolean — scrape related videos for postURLs (default: false)",
      "    shouldDownloadVideos: boolean — download TikTok videos (charged add-on, default: false)",
      "    shouldDownloadSubtitles: boolean — download subtitles (default: false)",
      "    shouldDownloadCovers: boolean — download thumbnails (default: false)",
      "    shouldDownloadAvatars: boolean — download profile avatars (default: false)",
      "    shouldDownloadSlideshowImages: boolean — download slideshow images (default: false)",
      "    shouldDownloadMusicCovers: boolean — download sound covers (default: false)",
      "    commentsPerPost: number — max comments per post (0 = none)",
      "    maxRepliesPerComment: number — max replies per comment (0 = none)",
      "    maxFollowersPerProfile: number — scrape follower profiles (0 = none, charged)",
      "    maxFollowingPerProfile: number — scrape following profiles (0 = none, charged)",
      "    proxyCountryCode: string — ISO country code for proxy, e.g. 'US', 'GB' (default: None)",
      "",
    );
  }

  if (allowed.has("youtube")) {
    lines.push(
      'YOUTUBE (platform="youtube"):',
      "  Provide either urls or queries. At least one is required.",
      "  actorInput options for YouTube:",
      "    maxResults: number — max videos per search term (default: 10)",
      "    maxResultsShorts: number — max shorts per search (default: 0)",
      "    maxResultStreams: number — max streams per search (default: 0)",
      "    downloadSubtitles: boolean — download video subtitles in SRT format (default: false)",
      "    subtitlesLanguage: string — subtitle language: any | en | de | es | fr | it | ja | ko | nl | pt | ru (default: en)",
      "    subtitlesFormat: string — subtitle format: srt | vtt | xml | plaintext (default: srt)",
      "    preferAutoGeneratedSubtitles: boolean — prefer auto-generated over user subtitles (default: false)",
      "    saveSubsToKVS: boolean — save subtitles to key-value store (default: false)",
      "    sortingOrder: string — sort search results: relevance | rating | date | views",
      "    dateFilter: string — upload date filter: hour | today | week | month | year",
      "    videoType: string — video type filter: video | movie",
      "    lengthFilter: string — length filter: under4 | between420 | plus20",
      "    isHD: boolean — HD filter | is4K: boolean — 4K filter | isLive: boolean — Live filter",
      "    hasSubtitles: boolean — Subtitles/CC filter | hasCC: boolean — Creative Commons filter",
      '    oldestPostDate: string — scrape channel videos after this date, e.g. "2024-01-01" or "30 days"',
      "    sortVideosBy: string — sort channel videos: NEWEST | POPULAR | OLDEST",
      "",
    );
  }

  if (allowed.has("linkedin")) {
    lines.push(
      'LINKEDIN (platform="linkedin"):',
      "  Requires: linkedinAction.",
      "",
      '  linkedinAction="profiles" — scrape LinkedIn profile details:',
      "    Provide urls (profile URLs) and/or profiles (usernames).",
      "    Returns: profile info, work experience, education, certifications.",
      "    Up to 1000 profiles per batch.",
      "",
      '  linkedinAction="company" — scrape LinkedIn company details (+ optionally posts):',
      "    Requires: urls (LinkedIn company profile URLs, e.g. https://www.linkedin.com/company/tesla-motors).",
      "    includePosts: boolean (default true) — also scrape company posts using the same URLs.",
      "    companyPostLimit: number (1-100) — max posts per company (default: maxResults). Only applies to the posts run.",
      "    When includePosts=true, fires TWO concurrent runs (details + posts) returning two run references.",
      "    Note: actorInput is only applied to the company-details run, not the posts run. Use companyPostLimit to control post limits.",
      "    Returns: company name, industry, website, employee count, description, specialities.",
      "",
      '  linkedinAction="jobs" — scrape LinkedIn job listings:',
      "    Requires: urls (LinkedIn jobs search URLs from linkedin.com/jobs/search/).",
      "    Returns: job title, company, location, salary, description.",
      "",
      "  actorInput options for LinkedIn:",
      "    profiles: includeEmail (boolean, default false) — include email if available",
      "    company posts: limit (number, 1-100, default 100) — max posts per company",
      "    jobs: scrapeCompany (boolean, default true) — include company details with job listings",
      "    jobs: count (number, min 100) — limit total jobs scraped",
      "    jobs: splitByLocation (boolean, default false) — split search by city to bypass 1000 job limit",
      "    jobs: splitCountry (string) — country code for location split (e.g. 'US', 'GB')",
      "",
    );
  }

  lines.push(
    "EXAMPLE — scrape Instagram and TikTok concurrently:",
    '  { action: "start", requests: [',
    '    { platform: "instagram", instagramMode: "search", instagramType: "hashtags", queries: ["sunset"] },',
    '    { platform: "tiktok", tiktokType: "search", queries: ["AI tools"], actorInput: { searchSection: "/video", searchSorting: "3" } }',
    "  ]}",
    "  → returns { runs: [{ runId, platform, datasetId }, ...] }",
    '  Then: { action: "collect", runs: <runs from above> }',
    "",
    "EXAMPLE — scrape LinkedIn company details + posts, and profiles in parallel:",
    '  { action: "start", requests: [',
    '    { platform: "linkedin", linkedinAction: "company", urls: ["https://www.linkedin.com/company/tesla-motors"] },',
    '    { platform: "linkedin", linkedinAction: "profiles", profiles: ["satyanadella", "neal-mohan"] }',
    "  ]}",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core logic — start
// ---------------------------------------------------------------------------

async function handleStart(params: {
  requests: Record<string, unknown>[];
  allowedPlatforms: Set<SocialPlatform>;
  apiKey: string;
  baseUrl: string;
  defaultMaxResults: number;
}): Promise<Record<string, unknown>> {
  if (!params.requests?.length) {
    throw new ToolInputError("'start' action requires 'requests' array with at least one request.");
  }

  const prepared: {
    platform: SocialPlatform;
    actorId: string;
    input: Record<string, unknown>;
    linkedinRunType?: LinkedinRunType;
  }[] = [];

  for (const req of params.requests) {
    const platform = readStringParam(req, "platform", { required: true }) as SocialPlatform;
    if (!params.allowedPlatforms.has(platform)) {
      throw new ToolInputError(`Platform "${platform}" is not enabled.`);
    }

    const common: CommonParams = {
      urls: readStringArrayParam(req, "urls"),
      queries: readStringArrayParam(req, "queries"),
      hashtags: readStringArrayParam(req, "hashtags"),
      profiles: readStringArrayParam(req, "profiles"),
      maxResults: readNumberParam(req, "maxResults") ?? params.defaultMaxResults,
    };
    const actorInput =
      req.actorInput && typeof req.actorInput === "object" && !Array.isArray(req.actorInput)
        ? (req.actorInput as Record<string, unknown>)
        : {};

    const handler = HANDLERS[platform];
    const runs = handler.prepare(req, common);
    for (const run of runs) {
      const mergedInput =
        run.runType === "company_posts" ? run.input : { ...run.input, ...actorInput };
      prepared.push({
        platform,
        actorId: run.actorId,
        input: mergedInput,
        linkedinRunType: run.runType as LinkedinRunType | undefined,
      });
    }
  }

  const results = await Promise.allSettled(
    prepared.map(async ({ platform, actorId, input, linkedinRunType }) => {
      const run = await startApifyActorRun({
        actorId,
        input,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });
      return {
        platform,
        runId: run.id,
        datasetId: run.defaultDatasetId,
        status: run.status,
        ...(linkedinRunType ? { linkedinAction: linkedinRunType } : {}),
      };
    }),
  );

  const runs: Record<string, unknown>[] = [];
  const errors: { index: number; platform: string; error: string }[] = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      runs.push(result.value);
    } else {
      errors.push({
        index: i,
        platform: prepared[i].platform,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return {
    action: "start",
    message:
      `Started ${runs.length} scraping job(s)` +
      (errors.length ? `, ${errors.length} failed to start` : "") +
      ". Use action 'collect' with the runs array to fetch results.",
    runs,
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core logic — collect
// ---------------------------------------------------------------------------

async function handleCollect(params: {
  runs: Record<string, unknown>[];
  apiKey: string;
  baseUrl: string;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  if (!params.runs?.length) {
    throw new ToolInputError("'collect' action requires 'runs' array.");
  }

  const results = await Promise.allSettled(
    params.runs.map(async (runRef) => {
      const runId = readStringParam(runRef, "runId", { required: true });
      const platform = readStringParam(runRef, "platform", {
        required: true,
      }) as SocialPlatform;
      const datasetId = readStringParam(runRef, "datasetId", { required: true });
      const linkedinRunType = readStringParam(runRef, "linkedinAction") as
        | LinkedinRunType
        | undefined;

      const cacheKey = normalizeCacheKey(`social:run:${runId}`);
      const cached = readCache(SOCIAL_CACHE, cacheKey);
      if (cached) {
        return { ...cached.value, cached: true };
      }

      const runStatus = await getApifyRunStatus({
        runId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });

      if (!TERMINAL_STATUSES.has(runStatus.status)) {
        return {
          platform,
          runId,
          status: runStatus.status,
          pending: true,
        } as Record<string, unknown>;
      }

      if (runStatus.status !== "SUCCEEDED") {
        return {
          platform,
          runId,
          status: runStatus.status,
          error: `Run ended with status: ${runStatus.status}`,
        } as Record<string, unknown>;
      }

      const items = await getApifyDatasetItems({
        datasetId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });

      const text = formatPlatformResults(platform, items, linkedinRunType);
      const wrapped = wrapExternalContent(text, {
        source: "Social Platforms",
        includeWarning: false,
      });

      const payload: Record<string, unknown> = {
        platform,
        runId,
        status: "SUCCEEDED",
        resultCount: items.length,
        text: wrapped,
        externalContent: { untrusted: true, source: "social_platforms", wrapped: true },
        fetchedAt: new Date().toISOString(),
      };

      writeCache(SOCIAL_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    }),
  );

  const completed: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push({
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      continue;
    }
    const value = result.value;
    if (value.pending) {
      pending.push(value);
    } else if (value.error) {
      errors.push(value);
    } else {
      completed.push(value);
    }
  }

  return {
    action: "collect",
    allDone: pending.length === 0,
    message:
      pending.length === 0
        ? `All ${completed.length} run(s) completed.`
        : `${completed.length} completed, ${pending.length} still running. Call collect again for pending runs.`,
    completed,
    ...(pending.length ? { pending } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main tool factory
// ---------------------------------------------------------------------------

export function createSocialPlatformsTool(options?: {
  pluginConfig?: Record<string, unknown>;
}): AnyAgentTool | null {
  const config = parsePluginConfig(options?.pluginConfig);
  const apiKey = resolveSocialApiKey(config);
  if (!resolveSocialEnabled({ config, apiKey })) {
    return null;
  }

  const allowedPlatforms = resolveAllowedPlatforms(config);
  const baseUrl = resolveSocialBaseUrl(config);
  const defaultMaxResults = resolveMaxResults(config);
  const cacheTtlMs = resolveCacheTtlMs(config.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const description = buildToolDescription(allowedPlatforms);

  return {
    label: "Social Platforms",
    name: "social_platforms",
    description,
    parameters: SocialPlatformsSchema,
    execute: async (_toolCallId, args) => {
      const typedArgs = args as Record<string, unknown>;
      const action = readStringParam(typedArgs, "action", { required: true });

      if (!apiKey) {
        return jsonResult({
          error: "missing_api_key",
          message:
            "Set APIFY_API_KEY env var or configure apiKey in the apify-social plugin config.",
        });
      }

      switch (action) {
        case "start":
          return jsonResult(
            await handleStart({
              requests: typedArgs.requests as Record<string, unknown>[],
              allowedPlatforms,
              apiKey,
              baseUrl,
              defaultMaxResults,
            }),
          );
        case "collect":
          return jsonResult(
            await handleCollect({
              runs: typedArgs.runs as Record<string, unknown>[],
              apiKey,
              baseUrl,
              cacheTtlMs,
            }),
          );
        default:
          throw new ToolInputError(`Unknown action: "${action}". Use "start" or "collect".`);
      }
    },
  };
}
