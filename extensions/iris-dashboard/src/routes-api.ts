import type { IncomingMessage, ServerResponse } from "node:http";
import { checkMutableAuth } from "./auth.js";
import type { DashboardConfig } from "./config.js";
import type { SupabaseClient } from "./supabase.js";
import {
  serviceCreateTask,
  serviceFetchTask,
  serviceListTasks,
  serviceRestoreTask,
  serviceSoftDeleteTask,
  serviceUpdateTask,
} from "./tasks-service.js";
import { validateCreateTask, validateListParams, validateUpdateTask } from "./validation.js";

const PREFIX = "/iris-dashboard/api/tasks";

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(payload);
}

function errorResponse(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  jsonResponse(res, status, {
    ok: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString("utf-8"));
}

/** Extract task ID from path like /iris-dashboard/api/tasks/<id> or /iris-dashboard/api/tasks/<id>/restore */
function extractTaskId(pathname: string): { id: string; restore: boolean } | null {
  const rest = pathname.slice(PREFIX.length);
  if (!rest || rest === "/") return null;

  // rest is either "/<uuid>" or "/<uuid>/restore"
  const parts = rest.replace(/^\//, "").split("/");
  if (parts.length === 1 && parts[0]) {
    return { id: parts[0], restore: false };
  }
  if (parts.length === 2 && parts[0] && parts[1] === "restore") {
    return { id: parts[0], restore: true };
  }
  return null;
}

/** Main handler for all /iris-dashboard/api/tasks* routes.
 *  Returns true if the request was handled, false otherwise. */
export async function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  config: DashboardConfig,
  client: SupabaseClient,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith(PREFIX)) return false;

  const method = req.method?.toUpperCase() ?? "GET";
  const taskRef = extractTaskId(pathname);

  try {
    // --- Collection routes: /iris-dashboard/api/tasks ---
    if (!taskRef) {
      if (method === "GET") {
        const vr = validateListParams(url.searchParams);
        if (!vr.ok) {
          errorResponse(res, 400, "VALIDATION_ERROR", vr.error);
          return true;
        }
        const { items, total } = await serviceListTasks(client, vr.data);
        jsonResponse(res, 200, {
          ok: true,
          data: { items, page: { limit: vr.data.limit, offset: vr.data.offset, total } },
        });
        return true;
      }

      if (method === "POST") {
        if (!checkMutableAuth(req, config)) {
          errorResponse(res, 401, "UNAUTHORIZED", "Authentication required");
          return true;
        }
        const rawBody = await parseJsonBody(req).catch(() => null);
        if (rawBody === null) {
          errorResponse(res, 400, "VALIDATION_ERROR", "Invalid JSON body");
          return true;
        }
        const vr = validateCreateTask(rawBody);
        if (!vr.ok) {
          errorResponse(res, 400, "VALIDATION_ERROR", vr.error);
          return true;
        }
        const task = await serviceCreateTask(client, vr.data);
        jsonResponse(res, 201, { ok: true, data: { task } });
        return true;
      }

      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed`);
      return true;
    }

    // --- Single-task routes: /iris-dashboard/api/tasks/:id[/restore] ---
    const { id, restore } = taskRef;

    if (restore) {
      // POST /iris-dashboard/api/tasks/:id/restore
      if (method !== "POST") {
        errorResponse(res, 405, "METHOD_NOT_ALLOWED", "Use POST to restore");
        return true;
      }
      if (!checkMutableAuth(req, config)) {
        errorResponse(res, 401, "UNAUTHORIZED", "Authentication required");
        return true;
      }
      const task = await serviceRestoreTask(client, id);
      if (!task) {
        errorResponse(res, 404, "NOT_FOUND", `Task ${id} not found`);
        return true;
      }
      jsonResponse(res, 200, { ok: true, data: { task } });
      return true;
    }

    if (method === "GET") {
      const includeDeleted = url.searchParams.get("include_deleted") === "true";
      const task = await serviceFetchTask(client, id, includeDeleted);
      if (!task) {
        errorResponse(res, 404, "NOT_FOUND", `Task ${id} not found`);
        return true;
      }
      jsonResponse(res, 200, { ok: true, data: { task } });
      return true;
    }

    if (method === "PATCH") {
      if (!checkMutableAuth(req, config)) {
        errorResponse(res, 401, "UNAUTHORIZED", "Authentication required");
        return true;
      }
      const rawBody = await parseJsonBody(req).catch(() => null);
      if (rawBody === null) {
        errorResponse(res, 400, "VALIDATION_ERROR", "Invalid JSON body");
        return true;
      }
      const vr = validateUpdateTask(rawBody);
      if (!vr.ok) {
        errorResponse(res, 400, "VALIDATION_ERROR", vr.error);
        return true;
      }
      const task = await serviceUpdateTask(client, id, vr.data);
      if (!task) {
        errorResponse(res, 404, "NOT_FOUND", `Task ${id} not found`);
        return true;
      }
      jsonResponse(res, 200, { ok: true, data: { task } });
      return true;
    }

    if (method === "DELETE") {
      if (!checkMutableAuth(req, config)) {
        errorResponse(res, 401, "UNAUTHORIZED", "Authentication required");
        return true;
      }
      const result = await serviceSoftDeleteTask(client, id);
      if (!result) {
        errorResponse(res, 404, "NOT_FOUND", `Task ${id} not found`);
        return true;
      }
      jsonResponse(res, 200, { ok: true, data: result });
      return true;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iris-dashboard] API error:", err);
    errorResponse(res, 500, "INTERNAL_ERROR", msg);
    return true;
  }
}
