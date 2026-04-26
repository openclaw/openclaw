// HTTP handlers for the orchestrator's `/orchestrator/*` route prefix.
// Mounted by `index.ts` via `api.registerHttpRoute({path:"/orchestrator/",
// match:"prefix", auth:"plugin", handler})`. Auth is enforced inside the
// handler against `~/.openclaw/credentials/orchestrator-bearer.json`
// (recon A-B3). Mode gating (synthetic / shadow / live) reads from
// pluginConfig at register time.
//
// The handler dispatches by `req.method` + parsed URL path. The
// endpoints surfaced are documented in Plan 005 Cross-Repo Contract:
//
//   GET  /orchestrator/health                       (public — no auth)
//   GET  /orchestrator/routing/preview              (auth — pure routing)
//   GET  /orchestrator/tasks                        (auth — list)
//   GET  /orchestrator/tasks/<id>                   (auth — single)
//   POST /orchestrator/tasks                        (auth — submit)
//   POST /orchestrator/tasks/<id>/transition        (auth — approve/reject)

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OrchestratorCredentials } from "./credentials.js";
import { decide, type CompiledRoutingConfig } from "./routing.js";
import { StoreError, type Store, type TransitionAction } from "./store.js";
import type { Task, TaskKind, TaskState } from "./types/schema.js";

export type DispatchMode = "synthetic" | "shadow" | "live";

export interface SubmitInput {
  goal: string;
  workspaceDir?: string | null;
  requiredCapabilities?: string[];
  submittedBy: string;
  kind?: TaskKind;
}

export interface DispatchInvoker {
  (task: Task): Promise<Task> | Task;
}

export interface HttpHandlersOptions {
  store: Store;
  routingConfig: CompiledRoutingConfig;
  /** Bearer token to compare against. If null, all auth-gated routes return 503. */
  credentials: OrchestratorCredentials | null;
  /** Current dispatch mode. v0 default is "synthetic". */
  mode: DispatchMode;
  /** Identifier of the operator/user submitting tasks. Falls back to "operator". */
  defaultSubmittedBy?: string;
  /** Called after `store.submit()` to advance state. Optional. */
  dispatch?: DispatchInvoker;
}

export interface OrchestratorHttpHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

const ROUTE_PREFIX = "/orchestrator/";
const HEALTH_PATH = "/orchestrator/health";
const ROUTING_PREVIEW_PATH = "/orchestrator/routing/preview";
const TASKS_PATH = "/orchestrator/tasks";

// ---- Helpers -----------------------------------------------------------

interface ParsedRequest {
  method: string;
  pathname: string;
  search: URLSearchParams;
}

function parseRequest(req: IncomingMessage): ParsedRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    method: (req.method ?? "GET").toUpperCase(),
    pathname: url.pathname,
    search: url.searchParams,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload, "utf8").toString());
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { code, message, ...(details ?? {}) } });
}

async function readBody(req: IncomingMessage, limitBytes = 16 * 1024): Promise<string> {
  return await new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limitBytes) {
        rejectBody(new Error(`request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => rejectBody(err));
  });
}

async function parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendError(res, 413, "request_too_large", (err as Error).message);
    return null;
  }
  if (raw.trim() === "") {
    sendError(res, 400, "missing_body", "request body is required");
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    sendError(res, 400, "invalid_json", "request body is not valid JSON");
    return null;
  }
}

function bearerOk(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return match[1] === expected;
}

function isStateValue(value: string | null): value is TaskState {
  return (
    value === "queued" ||
    value === "assigned" ||
    value === "in_progress" ||
    value === "awaiting_approval" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function isKindValue(value: string | null): value is TaskKind {
  return value === "live" || value === "synthetic" || value === "shadow";
}

// ---- Handler -----------------------------------------------------------

export function createOrchestratorHttpHandler(opts: HttpHandlersOptions): OrchestratorHttpHandler {
  const submittedByDefault = opts.defaultSubmittedBy ?? "operator";

  return async function handler(req, res): Promise<boolean> {
    const { method, pathname, search } = parseRequest(req);
    if (!pathname.startsWith(ROUTE_PREFIX)) {
      return false;
    }

    // GET /orchestrator/health — public
    if (method === "GET" && pathname === HEALTH_PATH) {
      sendJson(res, 200, {
        ok: true,
        mode: opts.mode,
        version: 1,
        hasCredentials: opts.credentials !== null,
      });
      return true;
    }

    // Auth gate for everything else.
    if (opts.credentials === null) {
      sendError(
        res,
        503,
        "ORCHESTRATOR_NOT_INITIALIZED",
        "Run `openclaw orchestrator init` before calling this endpoint.",
      );
      return true;
    }
    if (!bearerOk(req, opts.credentials.token)) {
      sendError(res, 401, "unauthorized", "missing or invalid Bearer token");
      return true;
    }

    // GET /orchestrator/routing/preview?goal=…&capabilities=a,b
    if (method === "GET" && pathname === ROUTING_PREVIEW_PATH) {
      const goal = search.get("goal");
      if (goal == null || goal === "") {
        sendError(res, 400, "missing_goal", "query parameter `goal` is required");
        return true;
      }
      const capsParam = search.get("capabilities");
      const caps = capsParam ? capsParam.split(",").filter((c) => c.length > 0) : [];
      const decision = decide(goal, caps, opts.routingConfig);
      sendJson(res, 200, { decision });
      return true;
    }

    // GET /orchestrator/tasks
    if (method === "GET" && pathname === TASKS_PATH) {
      const stateParam = search.get("state");
      const kindParam = search.get("kind");
      const limitRaw = search.get("limit");
      const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
      const filter: Parameters<Store["list"]>[0] = {};
      if (stateParam) {
        if (!isStateValue(stateParam)) {
          sendError(res, 400, "invalid_state", `unknown state '${stateParam}'`);
          return true;
        }
        filter.state = stateParam;
      }
      if (kindParam) {
        if (!isKindValue(kindParam)) {
          sendError(res, 400, "invalid_kind", `unknown kind '${kindParam}'`);
          return true;
        }
        filter.kind = kindParam;
      }
      if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
        filter.limit = limit;
      }
      const tasks = opts.store.list(filter);
      sendJson(res, 200, { tasks });
      return true;
    }

    // GET /orchestrator/tasks/<id>
    const singleMatch = /^\/orchestrator\/tasks\/([^/]+)$/.exec(pathname);
    if (method === "GET" && singleMatch) {
      const id = decodeURIComponent(singleMatch[1]!);
      try {
        const task = opts.store.read(id);
        sendJson(res, 200, { task });
      } catch (err) {
        if (err instanceof StoreError && err.code === "not_found") {
          sendError(res, 404, "not_found", `task ${id} does not exist`);
        } else if (err instanceof StoreError && err.code === "schema_drift") {
          sendError(res, 500, "schema_drift", `task ${id} has unknown schema version`);
        } else {
          throw err;
        }
      }
      return true;
    }

    // POST /orchestrator/tasks
    if (method === "POST" && pathname === TASKS_PATH) {
      if (opts.mode !== "synthetic") {
        sendError(
          res,
          403,
          "LIVE_DISABLED",
          `task submission requires mode='synthetic' in v0 (current: ${opts.mode}). Shadow / live flips land in later units.`,
        );
        return true;
      }
      const body = await parseJsonBody<SubmitInput>(req, res);
      if (body === null) return true;
      if (typeof body.goal !== "string" || body.goal.trim() === "") {
        sendError(res, 400, "missing_goal", "`goal` is required and non-empty");
        return true;
      }
      if (Buffer.byteLength(body.goal, "utf8") > 8 * 1024) {
        sendError(res, 400, "goal_too_long", "`goal` must be ≤ 8 KB");
        return true;
      }
      // Route is mode-gated to synthetic (the LIVE_DISABLED check above), so
      // force kind here. Trusting body.kind would let a client submit
      // {kind: "live"} into the synthetic namespace and bypass the gate.
      const queued = opts.store.submit({
        goal: body.goal,
        workspaceDir: body.workspaceDir ?? null,
        requiredCapabilities: body.requiredCapabilities ?? [],
        submittedBy: body.submittedBy ?? submittedByDefault,
        kind: "synthetic",
      });
      const final = opts.dispatch ? await opts.dispatch(queued) : queued;
      sendJson(res, 201, { task: final });
      return true;
    }

    // POST /orchestrator/tasks/<id>/transition
    const transitionMatch = /^\/orchestrator\/tasks\/([^/]+)\/transition$/.exec(pathname);
    if (method === "POST" && transitionMatch) {
      const id = decodeURIComponent(transitionMatch[1]!);
      const body = await parseJsonBody<{
        action?: string;
        reason?: string;
        by?: string;
      }>(req, res);
      if (body === null) return true;
      const operator = body.by ?? submittedByDefault;
      let action: TransitionAction;
      switch (body.action) {
        case "approve":
          action = { type: "approve" };
          break;
        case "reject": {
          const reason = body.reason;
          if (typeof reason !== "string" || reason.trim() === "" || reason.length > 1024) {
            sendError(
              res,
              400,
              "invalid_reason",
              "`reason` is required for reject and must be ≤ 1024 chars",
            );
            return true;
          }
          action = {
            type: "reject",
            rejection: {
              by: operator,
              reason,
              at: new Date().toISOString(),
            },
          };
          break;
        }
        case "cancel":
          action = { type: "cancel", by: operator };
          break;
        default:
          sendError(
            res,
            400,
            "invalid_action",
            `unknown action '${body.action ?? "<missing>"}' (expected approve | reject | cancel)`,
          );
          return true;
      }
      try {
        const updated = opts.store.transition(id, action);
        sendJson(res, 200, { task: updated });
      } catch (err) {
        if (err instanceof StoreError) {
          switch (err.code) {
            case "not_found":
              sendError(res, 404, "not_found", `task ${id} does not exist`);
              break;
            case "lock_held":
              sendError(
                res,
                409,
                "lock_held",
                `task ${id} is being modified by another caller; retry`,
              );
              break;
            case "invalid_transition":
              sendError(res, 409, "invalid_transition", err.message, err.details);
              break;
            default:
              sendError(res, 500, "store_error", err.message);
          }
        } else {
          throw err;
        }
      }
      return true;
    }

    // Method not allowed for known paths.
    if (pathname === HEALTH_PATH) {
      sendError(res, 405, "method_not_allowed", "GET only");
      return true;
    }
    if (pathname === ROUTING_PREVIEW_PATH) {
      sendError(res, 405, "method_not_allowed", "GET only");
      return true;
    }
    if (pathname === TASKS_PATH || singleMatch || transitionMatch) {
      sendError(res, 405, "method_not_allowed", `${method} not supported`);
      return true;
    }

    sendError(res, 404, "unknown_route", `${method} ${pathname} not found`);
    return true;
  };
}
