import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../../../src/agents/schema/typebox.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

const CANVAS_LMS_ACTIONS = ["list_courses", "list_assignments", "list_announcements"] as const;
const ASSIGNMENT_BUCKETS = ["all", "upcoming", "undated", "past"] as const;

type CanvasLmsPluginConfig = {
  baseUrl?: string;
  token?: string;
  defaultPerPage?: number;
};

type FetchLike = typeof fetch;

function normalizeBaseUrl(input: string): string {
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
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Canvas baseUrl must use http:// or https://");
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

async function fetchPaginatedArray(params: {
  fetchImpl: FetchLike;
  apiBase: string;
  token: string;
  firstPath: string;
  maxPages?: number;
}): Promise<unknown[]> {
  const out: unknown[] = [];
  let nextUrl = `${params.apiBase}${params.firstPath}`;
  let pages = 0;
  const maxPages = params.maxPages ?? 5;

  while (nextUrl && pages < maxPages) {
    const response = await params.fetchImpl(nextUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/json",
      },
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
          description: "Canvas API token. Prefer plugin config over inline token.",
        }),
      ),
      courseId: Type.Optional(
        Type.String({
          description: "Canvas course ID (required for assignments and announcements).",
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

      const baseUrl = normalizeBaseUrl(
        readString(args, "baseUrl") ??
          pluginConfig.baseUrl ??
          process.env.CANVAS_LMS_BASE_URL ??
          "",
      );
      const token =
        readString(args, "token") ?? pluginConfig.token ?? process.env.CANVAS_LMS_TOKEN ?? "";
      if (!token) {
        throw new Error(
          "Canvas token is required. Set it in plugin config (`token`) or CANVAS_LMS_TOKEN.",
        );
      }
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
  fetchPaginatedArray,
};
