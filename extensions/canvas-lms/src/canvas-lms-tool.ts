import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../../../src/agents/schema/typebox.js";
import { callGateway, randomIdempotencyKey } from "../../../src/gateway/call.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

const CANVAS_LMS_ACTIONS = [
  "list_courses",
  "list_assignments",
  "list_announcements",
  "list_modules",
  "list_submissions",
  "list_calendar_events",
  "list_grades",
  "list_course_files",
  "sync_academic_digest",
] as const;
const ASSIGNMENT_BUCKETS = ["all", "upcoming", "undated", "past"] as const;
const DIGEST_WINDOWS = ["today", "week"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PAGES = 5;

type CanvasLmsPluginConfig = {
  baseUrl?: string;
  token?: string;
  oauth?: {
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    accessToken?: string;
    expiresAt?: string | number;
  };
  defaultPerPage?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  allowInlineToken?: boolean;
  allowInsecureHttp?: boolean;
  digestPublishSessionKeys?: string[];
};

type FetchLike = typeof fetch;
type OAuthRuntimeConfig = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
};

type OAuthTokenState = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

const oauthTokenCache = new Map<string, OAuthTokenState>();

function normalizeBaseUrl(input: string, options?: { allowInsecureHttp?: boolean }): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Canvas baseUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Canvas baseUrl: ${trimmed}`);
  }
  if (parsed.protocol !== "https:") {
    if (parsed.protocol !== "http:") {
      throw new Error("Canvas baseUrl must use https://");
    }
    if (options?.allowInsecureHttp !== true) {
      throw new Error("Canvas baseUrl must use https:// (http:// is disabled by default)");
    }
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function extractNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const segments = linkHeader.split(",");
  for (const segment of segments) {
    const match = segment.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/i);
    if ((match?.[2] ?? "").toLowerCase() === "next") {
      return match?.[1] ?? null;
    }
  }
  return null;
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readPerPage(params: Record<string, unknown>, configured?: number): number {
  const local = typeof params.perPage === "number" ? params.perPage : undefined;
  const candidate = local ?? configured ?? 20;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return 20;
  }
  return Math.max(1, Math.min(100, Math.floor(candidate)));
}

function readPositiveInt(
  value: unknown,
  options: { fallback: number; min: number; max: number; allowZero?: boolean },
): number {
  const min = options.allowZero ? Math.min(0, options.min) : Math.max(1, options.min);
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return options.fallback;
  }
  return Math.max(min, Math.min(options.max, Math.floor(value)));
}

function computeRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

function parseExpiresAtMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Support both seconds and milliseconds inputs.
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDigestDateRange(params: { window: "today" | "week"; now: Date }): {
  start: Date;
  end: Date;
} {
  const start = new Date(params.now);
  if (params.window === "today") {
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
  }
  return { start, end: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDueLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function buildAcademicDigest(params: {
  items: Array<{
    courseId: string;
    courseName: string;
    assignmentId: string;
    assignmentName: string;
    dueAt: string;
    htmlUrl?: string;
  }>;
  window: "today" | "week";
  now: Date;
  timeZone: string;
}): string {
  const label = params.window === "today" ? "today" : "next 7 days";
  if (params.items.length === 0) {
    return `Academic sync (${label}): no assignments due.`;
  }

  const lines: string[] = [`Academic sync (${label})`, `Total due: ${params.items.length}`];
  const byDay = new Map<string, typeof params.items>();
  for (const item of params.items) {
    const dayKey = formatDateInTimeZone(new Date(item.dueAt), params.timeZone);
    byDay.set(dayKey, [...(byDay.get(dayKey) ?? []), item]);
  }
  const sortedDays = Array.from(byDay.keys()).sort();
  for (const day of sortedDays) {
    lines.push(`- ${day}`);
    const dayItems = (byDay.get(day) ?? []).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    for (const item of dayItems) {
      const dueLabel = formatDueLabel(new Date(item.dueAt), params.timeZone);
      const urlPart = item.htmlUrl ? ` (${item.htmlUrl})` : "";
      lines.push(`  - ${dueLabel} | ${item.courseName} | ${item.assignmentName}${urlPart}`);
    }
  }
  lines.push(`Generated at: ${params.now.toISOString()}`);
  return lines.join("\n");
}

function resolveOAuthConfig(params: {
  pluginConfig: CanvasLmsPluginConfig;
  baseUrl: string;
  allowInsecureHttp: boolean;
}): OAuthRuntimeConfig | undefined {
  const configured = params.pluginConfig.oauth;
  const clientId =
    readConfigString(configured?.clientId) ??
    readConfigString(process.env.CANVAS_LMS_OAUTH_CLIENT_ID);
  const clientSecret =
    readConfigString(configured?.clientSecret) ??
    readConfigString(process.env.CANVAS_LMS_OAUTH_CLIENT_SECRET);
  const refreshToken =
    readConfigString(configured?.refreshToken) ??
    readConfigString(process.env.CANVAS_LMS_OAUTH_REFRESH_TOKEN);
  const accessToken =
    readConfigString(configured?.accessToken) ??
    readConfigString(process.env.CANVAS_LMS_OAUTH_ACCESS_TOKEN);
  const expiresAt = parseExpiresAtMs(
    configured?.expiresAt ?? process.env.CANVAS_LMS_OAUTH_EXPIRES_AT,
  );
  const tokenUrlRaw =
    readConfigString(configured?.tokenUrl) ??
    readConfigString(process.env.CANVAS_LMS_OAUTH_TOKEN_URL) ??
    `${params.baseUrl}/login/oauth2/token`;

  if (!clientId || !clientSecret) {
    return undefined;
  }

  let tokenUrl: URL;
  try {
    tokenUrl = new URL(tokenUrlRaw);
  } catch {
    throw new Error(`Invalid Canvas OAuth tokenUrl: ${tokenUrlRaw}`);
  }
  if (tokenUrl.protocol !== "https:") {
    if (tokenUrl.protocol !== "http:") {
      throw new Error("Canvas OAuth tokenUrl must use https://");
    }
    if (!params.allowInsecureHttp) {
      throw new Error("Canvas OAuth tokenUrl must use https:// (http:// is disabled by default)");
    }
  }

  if (!accessToken && !refreshToken) {
    throw new Error(
      "Canvas OAuth is configured but no accessToken/refreshToken found. Set oauth.refreshToken or CANVAS_LMS_OAUTH_REFRESH_TOKEN.",
    );
  }

  return {
    tokenUrl: tokenUrl.toString(),
    clientId,
    clientSecret,
    refreshToken,
    accessToken,
    expiresAt,
  };
}

function oauthCacheKey(config: OAuthRuntimeConfig): string {
  const suffix = (config.refreshToken ?? "no-refresh").slice(-8);
  return `${config.tokenUrl}|${config.clientId}|${suffix}`;
}

function shouldRefreshToken(state: OAuthTokenState): boolean {
  if (!state.accessToken) {
    return true;
  }
  if (!state.expiresAt) {
    return false;
  }
  return Date.now() >= state.expiresAt - 60_000;
}

async function refreshOAuthToken(params: {
  fetchImpl: FetchLike;
  config: OAuthRuntimeConfig;
  timeoutMs: number;
  maxRetries: number;
}): Promise<OAuthTokenState> {
  if (!params.config.refreshToken) {
    throw new Error("Canvas OAuth access token expired and no refreshToken is configured.");
  }
  const response = await fetchWithRetry({
    fetchImpl: params.fetchImpl,
    url: params.config.tokenUrl,
    token: params.config.accessToken ?? "oauth-refresh",
    timeoutMs: params.timeoutMs,
    maxRetries: params.maxRetries,
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.config.refreshToken,
      client_id: params.config.clientId,
      client_secret: params.config.clientSecret,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Canvas OAuth refresh failed (${response.status} ${response.statusText}): ${body.slice(0, 180)}`,
    );
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const accessToken = readConfigString(payload.access_token);
  if (!accessToken) {
    throw new Error("Canvas OAuth refresh did not return access_token.");
  }
  const expiresInSeconds =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : 3600;
  const expiresAt = Date.now() + expiresInSeconds * 1000 - 60_000;
  return {
    accessToken,
    refreshToken: readConfigString(payload.refresh_token) ?? params.config.refreshToken,
    expiresAt,
  };
}

async function resolveCanvasAuthToken(params: {
  args: Record<string, unknown>;
  pluginConfig: CanvasLmsPluginConfig;
  baseUrl: string;
  allowInsecureHttp: boolean;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl: FetchLike;
}): Promise<string> {
  const inlineToken = readString(params.args, "token");
  if (inlineToken && params.pluginConfig.allowInlineToken !== true) {
    throw new Error(
      "Inline token is disabled. Configure OAuth in plugin config/env (recommended) or allowInlineToken=true.",
    );
  }

  const oauth = resolveOAuthConfig({
    pluginConfig: params.pluginConfig,
    baseUrl: params.baseUrl,
    allowInsecureHttp: params.allowInsecureHttp,
  });
  if (oauth) {
    const key = oauthCacheKey(oauth);
    const cached = oauthTokenCache.get(key);
    let state: OAuthTokenState = cached ?? {
      accessToken: oauth.accessToken ?? "",
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    };
    if (shouldRefreshToken(state)) {
      state = await refreshOAuthToken({
        fetchImpl: params.fetchImpl,
        config: oauth,
        timeoutMs: params.timeoutMs,
        maxRetries: params.maxRetries,
      });
      oauthTokenCache.set(key, state);
    } else if (!cached) {
      oauthTokenCache.set(key, state);
    }
    if (!state.accessToken) {
      throw new Error("Canvas OAuth did not provide an access token.");
    }
    return state.accessToken;
  }

  const manualToken =
    inlineToken ?? params.pluginConfig.token ?? process.env.CANVAS_LMS_TOKEN ?? "";
  if (!manualToken) {
    throw new Error(
      "Canvas credentials are required. Configure OAuth (oauth.clientId/clientSecret + refreshToken) or CANVAS_LMS_TOKEN.",
    );
  }
  return manualToken;
}

async function fetchWithRetry(params: {
  fetchImpl: FetchLike;
  url: string;
  token?: string;
  timeoutMs: number;
  maxRetries: number;
  method?: "GET" | "POST";
  body?: URLSearchParams | string;
  headers?: Record<string, string>;
}): Promise<Response> {
  let attempt = 0;
  while (attempt <= params.maxRetries) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const response = await params.fetchImpl(params.url, {
        method: params.method ?? "GET",
        headers: {
          ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
          Accept: "application/json",
          ...(params.headers ?? {}),
        },
        ...(params.body ? { body: params.body } : {}),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if ((response.status === 429 || response.status >= 500) && attempt < params.maxRetries) {
        const retryAfter = computeRetryAfterMs(response.headers.get("retry-after"));
        const delay = retryAfter ?? Math.min(5_000, 300 * 2 ** attempt);
        await sleep(delay);
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      if (attempt >= params.maxRetries) {
        throw error;
      }
      await sleep(Math.min(2_000, 200 * 2 ** attempt));
      attempt += 1;
    }
  }
  throw new Error("Canvas request failed before receiving a response");
}

async function fetchPaginatedArray(params: {
  fetchImpl: FetchLike;
  apiBase: string;
  token: string;
  firstPath: string;
  maxPages?: number;
  timeoutMs: number;
  maxRetries: number;
}): Promise<unknown[]> {
  const out: unknown[] = [];
  let nextUrl = `${params.apiBase}${params.firstPath}`;
  let pages = 0;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;

  while (nextUrl && pages < maxPages) {
    const response = await fetchWithRetry({
      fetchImpl: params.fetchImpl,
      url: nextUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
      maxRetries: params.maxRetries,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Canvas request failed (${response.status} ${response.statusText}): ${body.slice(0, 240)}`,
      );
    }
    const payload = (await response.json()) as unknown;
    if (Array.isArray(payload)) {
      out.push(...payload);
    } else {
      throw new Error("Canvas API response was not an array");
    }
    nextUrl = extractNextLink(response.headers.get("link")) ?? "";
    pages += 1;
  }
  return out;
}

export function createCanvasLmsTool(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as CanvasLmsPluginConfig;
  return {
    name: "canvas-lms",
    label: "Canvas LMS",
    description:
      "Read data from Canvas LMS (courses, assignments, announcements, modules, submissions, calendar, grades, files) using a Canvas API token.",
    parameters: Type.Object({
      action: stringEnum(CANVAS_LMS_ACTIONS, {
        description: `Action to perform: ${CANVAS_LMS_ACTIONS.join(", ")}`,
      }),
      baseUrl: Type.Optional(
        Type.String({
          description: "Canvas base URL, for example: https://canvas.university.edu",
        }),
      ),
      token: Type.Optional(
        Type.String({
          description:
            "Canvas API token (inline). Disabled by default unless plugin config allowInlineToken=true.",
        }),
      ),
      courseId: Type.Optional(
        Type.String({
          description:
            "Canvas course ID (required for assignments, announcements, modules, and submissions).",
        }),
      ),
      assignmentId: Type.Optional(
        Type.String({
          description: "Canvas assignment ID (optional filter for list_submissions).",
        }),
      ),
      studentId: Type.Optional(
        Type.String({
          description: "Canvas student identifier for list_submissions (default: self).",
        }),
      ),
      digestWindow: optionalStringEnum(DIGEST_WINDOWS, {
        description: "Digest range for sync_academic_digest: today or week (default week).",
      }),
      publish: Type.Optional(
        Type.Boolean({
          description:
            "When true (sync_academic_digest), publish the generated summary via chat.send.",
        }),
      ),
      publishSessionKey: Type.Optional(
        Type.String({
          description:
            "Single target session key for publication (Discord/Teams/WhatsApp/Telegram/etc) when publish=true.",
        }),
      ),
      publishSessionKeys: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Multiple target session keys for publication (Discord/Teams/WhatsApp/Telegram/etc) when publish=true.",
          }),
        ),
      ),
      timeZone: Type.Optional(
        Type.String({
          description:
            "IANA timezone for digest grouping/formatting (e.g. America/Santiago). Defaults UTC.",
        }),
      ),
      startDate: Type.Optional(
        Type.String({
          description: "ISO date or datetime for calendar filters (used by list_calendar_events).",
        }),
      ),
      endDate: Type.Optional(
        Type.String({
          description: "ISO date or datetime for calendar filters (used by list_calendar_events).",
        }),
      ),
      bucket: optionalStringEnum(ASSIGNMENT_BUCKETS, {
        description: "Assignment bucket (used by list_assignments).",
      }),
      perPage: Type.Optional(Type.Number({ description: "Page size (1-100). Defaults to 20." })),
      includeCompleted: Type.Optional(
        Type.Boolean({
          description: "Include completed/inactive courses (list_courses only).",
        }),
      ),
    }),
    async execute(_id: string, args: Record<string, unknown>) {
      const action = readString(args, "action");
      if (!action) {
        throw new Error("action is required");
      }

      const allowInsecureHttp =
        pluginConfig.allowInsecureHttp === true ||
        process.env.CANVAS_LMS_ALLOW_INSECURE_HTTP === "1";
      const baseUrl = normalizeBaseUrl(
        readString(args, "baseUrl") ??
          pluginConfig.baseUrl ??
          process.env.CANVAS_LMS_BASE_URL ??
          "",
        { allowInsecureHttp },
      );
      const timeoutMs = readPositiveInt(pluginConfig.requestTimeoutMs, {
        fallback: DEFAULT_TIMEOUT_MS,
        min: 1_000,
        max: 120_000,
      });
      const maxRetries = readPositiveInt(pluginConfig.maxRetries, {
        fallback: DEFAULT_MAX_RETRIES,
        min: 0,
        max: 5,
        allowZero: true,
      });
      const maxPages = readPositiveInt(pluginConfig.maxPages, {
        fallback: DEFAULT_MAX_PAGES,
        min: 1,
        max: 50,
      });
      const token = await resolveCanvasAuthToken({
        args,
        pluginConfig,
        baseUrl,
        allowInsecureHttp,
        timeoutMs,
        maxRetries,
        fetchImpl: fetch,
      });
      const apiBase = `${baseUrl}/api/v1`;
      const perPage = readPerPage(args, pluginConfig.defaultPerPage);

      let rows: unknown[] = [];
      if (action === "list_courses") {
        const includeCompleted = args.includeCompleted === true;
        const enrollmentState = includeCompleted ? "all" : "active";
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses?per_page=${perPage}&enrollment_state=${enrollmentState}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_assignments") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_assignments");
        }
        const bucket = readString(args, "bucket") ?? "upcoming";
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses/${encodeURIComponent(courseId)}/assignments?per_page=${perPage}&bucket=${encodeURIComponent(
            bucket,
          )}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_announcements") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_announcements");
        }
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses/${encodeURIComponent(courseId)}/discussion_topics?only_announcements=true&per_page=${perPage}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_modules") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_modules");
        }
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses/${encodeURIComponent(courseId)}/modules?include[]=items&per_page=${perPage}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_submissions") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_submissions");
        }
        const studentId = readString(args, "studentId") ?? "self";
        const assignmentId = readString(args, "assignmentId");
        const assignmentFilter = assignmentId
          ? `&assignment_ids[]=${encodeURIComponent(assignmentId)}`
          : "";
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses/${encodeURIComponent(courseId)}/students/submissions?per_page=${perPage}&student_ids[]=${encodeURIComponent(
            studentId,
          )}${assignmentFilter}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_calendar_events") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_calendar_events");
        }
        const startDate = readString(args, "startDate");
        const endDate = readString(args, "endDate");
        const dateFilter = `${startDate ? `&start_date=${encodeURIComponent(startDate)}` : ""}${
          endDate ? `&end_date=${encodeURIComponent(endDate)}` : ""
        }`;
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/calendar_events?context_codes[]=${encodeURIComponent(`course_${courseId}`)}&per_page=${perPage}${dateFilter}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_grades") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_grades");
        }
        const studentId = readString(args, "studentId") ?? "self";
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses/${encodeURIComponent(courseId)}/enrollments?type[]=StudentEnrollment&user_id=${encodeURIComponent(
            studentId,
          )}&include[]=grades&include[]=current_points&include[]=total_scores&per_page=${perPage}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "list_course_files") {
        const courseId = readString(args, "courseId");
        if (!courseId) {
          throw new Error("courseId is required for list_course_files");
        }
        rows = await fetchPaginatedArray({
          fetchImpl: fetch,
          apiBase,
          token,
          firstPath: `/courses/${encodeURIComponent(courseId)}/files?per_page=${perPage}`,
          maxPages,
          timeoutMs,
          maxRetries,
        });
      } else if (action === "sync_academic_digest") {
        const digestWindow =
          (readString(args, "digestWindow") as "today" | "week" | undefined) ?? "week";
        const publish = args.publish === true;
        const legacyPublishSessionKey = readString(args, "publishSessionKey");
        const requestedPublishSessionKeys = readStringArray(args.publishSessionKeys);
        const configuredPublishSessionKeys = readStringArray(pluginConfig.digestPublishSessionKeys);
        const publishSessionKeys = Array.from(
          new Set([
            ...(legacyPublishSessionKey ? [legacyPublishSessionKey] : []),
            ...requestedPublishSessionKeys,
            ...configuredPublishSessionKeys,
          ]),
        );
        if (publish && publishSessionKeys.length === 0) {
          throw new Error(
            "At least one publish session key is required when publish=true (publishSessionKey, publishSessionKeys, or plugin digestPublishSessionKeys).",
          );
        }
        const timeZone = readString(args, "timeZone") ?? "UTC";
        try {
          void formatDateInTimeZone(new Date(), timeZone);
        } catch {
          throw new Error(`Invalid timeZone: ${timeZone}`);
        }

        const now = new Date();
        const range = resolveDigestDateRange({ window: digestWindow, now });
        const explicitCourseId = readString(args, "courseId");

        const courses = explicitCourseId
          ? [{ id: explicitCourseId, name: `Course ${explicitCourseId}` }]
          : (
              await fetchPaginatedArray({
                fetchImpl: fetch,
                apiBase,
                token,
                firstPath: `/courses?per_page=${Math.min(perPage, 30)}&enrollment_state=active`,
                maxPages: 1,
                timeoutMs,
                maxRetries,
              })
            )
              .map((row) => row as Record<string, unknown>)
              .map((course) => ({
                id: String(course.id ?? ""),
                name: String(course.name ?? course.course_code ?? "Untitled course"),
              }))
              .filter((course) => course.id);

        const dueItems: Array<{
          courseId: string;
          courseName: string;
          assignmentId: string;
          assignmentName: string;
          dueAt: string;
          htmlUrl?: string;
        }> = [];
        for (const course of courses) {
          const assignments = await fetchPaginatedArray({
            fetchImpl: fetch,
            apiBase,
            token,
            firstPath: `/courses/${encodeURIComponent(course.id)}/assignments?per_page=${perPage}&bucket=upcoming`,
            maxPages: 1,
            timeoutMs,
            maxRetries,
          });
          for (const row of assignments) {
            const item = row as Record<string, unknown>;
            const dueAt = readConfigString(item.due_at);
            if (!dueAt) {
              continue;
            }
            const dueDate = new Date(dueAt);
            if (Number.isNaN(dueDate.getTime())) {
              continue;
            }
            if (dueDate < range.start || dueDate >= range.end) {
              continue;
            }
            dueItems.push({
              courseId: course.id,
              courseName: course.name,
              assignmentId: String(item.id ?? ""),
              assignmentName: String(item.name ?? "Untitled assignment"),
              dueAt,
              htmlUrl: readConfigString(item.html_url),
            });
          }
        }

        dueItems.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        const summary = buildAcademicDigest({
          items: dueItems,
          window: digestWindow,
          now,
          timeZone,
        });

        const publishedSessionKeys: string[] = [];
        if (publish) {
          for (const sessionKey of publishSessionKeys) {
            const publishResult = (await callGateway({
              config: api.config,
              method: "chat.send",
              params: {
                sessionKey,
                message: summary,
                idempotencyKey: randomIdempotencyKey(),
              },
            })) as { ok?: boolean };
            if (publishResult && publishResult.ok === false) {
              throw new Error(`Failed to publish digest to target session: ${sessionKey}`);
            }
            publishedSessionKeys.push(sessionKey);
          }
        }

        return {
          content: [{ type: "text", text: summary }],
          details: {
            action,
            window: digestWindow,
            timeZone,
            totalDue: dueItems.length,
            coursesScanned: courses.length,
            published: publishedSessionKeys.length > 0,
            publishedCount: publishedSessionKeys.length,
            publishSessionKeys: publishedSessionKeys,
          },
        };
      } else {
        throw new Error(`Unsupported action: ${action}`);
      }

      const simplified = rows.map((row) => {
        const item = row as Record<string, unknown>;
        if (action === "list_courses") {
          return {
            id: item.id,
            name: item.name,
            courseCode: item.course_code,
            workflowState: item.workflow_state,
            startAt: item.start_at,
            endAt: item.end_at,
          };
        }
        if (action === "list_assignments") {
          return {
            id: item.id,
            name: item.name,
            dueAt: item.due_at,
            pointsPossible: item.points_possible,
            htmlUrl: item.html_url,
          };
        }
        if (action === "list_modules") {
          return {
            id: item.id,
            name: item.name,
            unlockAt: item.unlock_at,
            state: item.state,
            itemsCount: Array.isArray(item.items) ? item.items.length : undefined,
          };
        }
        if (action === "list_submissions") {
          return {
            assignmentId: item.assignment_id,
            userId: item.user_id,
            submittedAt: item.submitted_at,
            score: item.score,
            grade: item.grade,
            workflowState: item.workflow_state,
            late: item.late,
            missing: item.missing,
          };
        }
        if (action === "list_calendar_events") {
          return {
            id: item.id,
            title: item.title,
            startAt: item.start_at,
            endAt: item.end_at,
            allDay: item.all_day,
            locationName: item.location_name,
            htmlUrl: item.html_url,
          };
        }
        if (action === "list_grades") {
          const grades =
            item.grades && typeof item.grades === "object"
              ? (item.grades as Record<string, unknown>)
              : undefined;
          return {
            enrollmentId: item.id,
            userId: item.user_id,
            type: item.type,
            currentGrade: grades?.current_grade,
            currentScore: grades?.current_score,
            finalGrade: grades?.final_grade,
            finalScore: grades?.final_score,
            currentPoints: item.current_points,
            unpostedCurrentGrade: grades?.unposted_current_grade,
          };
        }
        if (action === "list_course_files") {
          return {
            id: item.id,
            displayName: item.display_name,
            filename: item.filename,
            size: item.size,
            contentType: item["content-type"],
            updatedAt: item.updated_at,
            url: item.url,
            locked: item.locked,
          };
        }
        return {
          id: item.id,
          title: item.title,
          postedAt: item.posted_at,
          message: item.message,
          htmlUrl: item.html_url,
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
        details: {
          action,
          total: simplified.length,
          baseUrl,
        },
      };
    },
  };
}

export const __test = {
  normalizeBaseUrl,
  extractNextLink,
  computeRetryAfterMs,
  parseExpiresAtMs,
  resolveOAuthConfig,
  shouldRefreshToken,
  fetchPaginatedArray,
};
