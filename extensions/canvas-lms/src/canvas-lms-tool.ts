import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../../../src/agents/schema/typebox.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

const CANVAS_LMS_ACTIONS = [
  "list_courses",
  "list_assignments",
  "list_announcements",
  "list_modules",
  "list_submissions",
] as const;
const ASSIGNMENT_BUCKETS = ["all", "upcoming", "undated", "past"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PAGES = 5;

type CanvasLmsPluginConfig = {
  baseUrl?: string;
  token?: string;
  defaultPerPage?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  allowInlineToken?: boolean;
  allowInsecureHttp?: boolean;
};

type FetchLike = typeof fetch;

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
  options: { fallback: number; min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return options.fallback;
  }
  return Math.max(options.min, Math.min(options.max, Math.floor(value)));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(params: {
  fetchImpl: FetchLike;
  url: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
}): Promise<Response> {
  let attempt = 0;
  while (attempt <= params.maxRetries) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const response = await params.fetchImpl(params.url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.token}`,
          Accept: "application/json",
        },
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
      "Read data from Canvas LMS (courses, assignments, announcements) using a Canvas API token.",
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
      const inlineToken = readString(args, "token");
      if (inlineToken && pluginConfig.allowInlineToken !== true) {
        throw new Error(
          "Inline token is disabled. Configure token in plugin config or CANVAS_LMS_TOKEN.",
        );
      }
      const token = inlineToken ?? pluginConfig.token ?? process.env.CANVAS_LMS_TOKEN ?? "";
      if (!token) {
        throw new Error(
          "Canvas token is required. Set it in plugin config (`token`) or CANVAS_LMS_TOKEN.",
        );
      }
      const apiBase = `${baseUrl}/api/v1`;
      const perPage = readPerPage(args, pluginConfig.defaultPerPage);
      const timeoutMs = readPositiveInt(pluginConfig.requestTimeoutMs, {
        fallback: DEFAULT_TIMEOUT_MS,
        min: 1_000,
        max: 120_000,
      });
      const maxRetries = readPositiveInt(pluginConfig.maxRetries, {
        fallback: DEFAULT_MAX_RETRIES,
        min: 0,
        max: 5,
      });
      const maxPages = readPositiveInt(pluginConfig.maxPages, {
        fallback: DEFAULT_MAX_PAGES,
        min: 1,
        max: 50,
      });

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
  fetchPaginatedArray,
};
