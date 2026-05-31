import {
  readResponseText,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";

const FXTWITTER_API_BASE_URL = "https://api.fxtwitter.com";
const STATUS_ID_PATTERN = /^\d{2,20}$/u;
const X_POST_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "fxtwitter.com",
  "www.fxtwitter.com",
  "fixupx.com",
  "www.fixupx.com",
  "vxtwitter.com",
  "www.vxtwitter.com",
]);

type FxTwitterPostAuthor = {
  name?: unknown;
  screen_name?: unknown;
  avatar_url?: unknown;
  url?: unknown;
};

type FxTwitterPost = {
  id?: unknown;
  url?: unknown;
  text?: unknown;
  created_at?: unknown;
  created_timestamp?: unknown;
  likes?: unknown;
  reposts?: unknown;
  retweets?: unknown;
  replies?: unknown;
  quotes?: unknown;
  views?: unknown;
  bookmarks?: unknown;
  lang?: unknown;
  source?: unknown;
  possibly_sensitive?: unknown;
  author?: FxTwitterPostAuthor;
  media?: unknown;
  quote?: unknown;
  poll?: unknown;
};

type FxTwitterPostResponse = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  tweet?: unknown;
};

export type FxTwitterPostReference = {
  id: string;
  handle?: string;
  sourceUrl?: string;
};

export type FxTwitterPostLookupResult = {
  apiUrl: string;
  response: FxTwitterPostResponse;
  post: FxTwitterPost;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstUrlCandidate(input: string): string | undefined {
  const match = /https?:\/\/[^\s<>)"']+/iu.exec(input);
  return match?.[0]?.replace(/[.,;:!?]+$/u, "");
}

function normalizeHandle(value: string | undefined): string | undefined {
  if (!value || value === "i") {
    return undefined;
  }
  return value.replace(/^@/u, "");
}

export function extractFxTwitterPostReference(input: string): FxTwitterPostReference | null {
  const query = input.trim();
  if (!query) {
    return null;
  }
  if (STATUS_ID_PATTERN.test(query)) {
    return { id: query };
  }

  const urlCandidate = firstUrlCandidate(query);
  if (!urlCandidate) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(urlCandidate);
  } catch {
    return null;
  }
  if (!X_POST_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const statusIndex = parts.findIndex((part) => /^(?:status|statuses)$/iu.test(part));
  if (statusIndex < 0) {
    return null;
  }
  const id = parts[statusIndex + 1];
  if (!id || !STATUS_ID_PATTERN.test(id)) {
    return null;
  }
  return {
    id,
    handle: normalizeHandle(parts[statusIndex - 1]),
    sourceUrl: url.toString(),
  };
}

export function buildFxTwitterPostApiUrl(ref: FxTwitterPostReference): string {
  const url = new URL(`/2/status/${encodeURIComponent(ref.id)}`, FXTWITTER_API_BASE_URL);
  url.searchParams.set("about_account", "1");
  return url.toString();
}

function responseStatusObject(response: FxTwitterPostResponse): FxTwitterPost | null {
  const status = isRecord(response.status) ? response.status : undefined;
  const tweet = isRecord(response.tweet) ? response.tweet : undefined;
  const candidate = status ?? tweet;
  if (!candidate) {
    return null;
  }
  return candidate as FxTwitterPost;
}

async function throwFxTwitterApiError(
  response: Response,
  body?: FxTwitterPostResponse,
): Promise<never> {
  const message = readString(body?.message);
  if (message) {
    throw new Error(`FxTwitter API error (${response.status}): ${message}`);
  }
  if (body) {
    throw new Error(`FxTwitter API error (${response.status}): ${JSON.stringify(body)}`);
  }
  const detail = await readResponseText(response, { maxBytes: 16_000 });
  throw new Error(
    `FxTwitter API error (${response.status}): ${detail.text || response.statusText}`,
  );
}

export async function requestFxTwitterPost(params: {
  ref: FxTwitterPostReference;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<FxTwitterPostLookupResult> {
  const apiUrl = buildFxTwitterPostApiUrl(params.ref);
  return await withTrustedWebToolsEndpoint(
    {
      url: apiUrl,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "OpenClaw FxTwitter reader (+https://github.com/openclaw/openclaw)",
        },
      },
    },
    async ({ response }) => {
      let body: FxTwitterPostResponse | undefined;
      try {
        body = (await response.json()) as FxTwitterPostResponse;
      } catch (error) {
        if (!response.ok) {
          await throwFxTwitterApiError(response);
        }
        throw new Error(
          `FxTwitter API returned invalid JSON${error instanceof Error ? `: ${error.message}` : ""}`,
          { cause: error },
        );
      }
      if (!response.ok || (typeof body.code === "number" && body.code >= 400)) {
        await throwFxTwitterApiError(response, body);
      }
      const post = responseStatusObject(body);
      if (!post) {
        throw new Error("FxTwitter API response did not include a status payload.");
      }
      return { apiUrl, response: body, post };
    },
  );
}

function countMediaItems(media: unknown, key: string): number {
  if (!isRecord(media)) {
    return 0;
  }
  const value = media[key];
  return Array.isArray(value) ? value.length : 0;
}

function formatMetric(label: string, value: unknown): string | null {
  const numberValue = readNumber(value);
  return numberValue === undefined ? null : `${label}: ${numberValue}`;
}

function summarizePostContent(post: FxTwitterPost): string {
  const author = isRecord(post.author) ? post.author : undefined;
  const name = readString(author?.name);
  const screenName = readString(author?.screen_name);
  const authorLabel = [name, screenName ? `@${screenName}` : undefined].filter(Boolean).join(" ");
  const metrics = [
    formatMetric("likes", post.likes),
    formatMetric("reposts", post.reposts ?? post.retweets),
    formatMetric("quotes", post.quotes),
    formatMetric("replies", post.replies),
    formatMetric("views", post.views),
    formatMetric("bookmarks", post.bookmarks),
  ].filter((entry): entry is string => Boolean(entry));
  const mediaParts = [
    formatMetric("photos", countMediaItems(post.media, "photos")),
    formatMetric("videos", countMediaItems(post.media, "videos")),
  ].filter((entry): entry is string => Boolean(entry));

  return [
    `X post${authorLabel ? ` by ${authorLabel}` : ""}`,
    readString(post.url) ? `URL: ${readString(post.url)}` : undefined,
    readString(post.created_at) ? `Created: ${readString(post.created_at)}` : undefined,
    readString(post.text) ? `Text: ${readString(post.text)}` : "Text: ",
    metrics.length ? `Engagement: ${metrics.join(", ")}` : undefined,
    mediaParts.length ? `Media: ${mediaParts.join(", ")}` : undefined,
    isRecord(post.quote) ? "Includes quote post metadata." : undefined,
    isRecord(post.poll) ? "Includes poll metadata." : undefined,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

export function buildFxTwitterPostPayload(params: {
  query: string;
  ref: FxTwitterPostReference;
  apiUrl: string;
  tookMs: number;
  post: FxTwitterPost;
}): Record<string, unknown> {
  const content = summarizePostContent(params.post);
  return {
    query: params.query,
    provider: "fxtwitter",
    mode: "exact_post",
    tookMs: params.tookMs,
    apiUrl: params.apiUrl,
    sourceUrl: params.ref.sourceUrl,
    statusId: params.ref.id,
    handle: params.ref.handle,
    externalContent: {
      untrusted: true,
      source: "x_search",
      provider: "fxtwitter",
      wrapped: true,
    },
    content: wrapWebContent(content, "web_search"),
    citations: [readString(params.post.url), params.ref.sourceUrl].filter(
      (entry, index, array): entry is string => Boolean(entry) && array.indexOf(entry) === index,
    ),
    post: params.post,
  };
}
