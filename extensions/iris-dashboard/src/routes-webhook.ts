import type { IncomingMessage, ServerResponse } from "node:http";
import { checkWebhookAuth } from "./auth.js";
import type { DashboardConfig } from "./config.js";

const WEBHOOK_PATH = "/iris-dashboard/webhook/tasks";

type WebhookBody = {
  type?: string;
  table?: string;
  schema?: string;
  record?: { id?: string; status?: string; [key: string]: unknown };
  old_record?: { id?: string; status?: string; [key: string]: unknown };
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(payload);
}

/** Handle POST /iris-dashboard/webhook/tasks.
 *  Returns true if handled. */
export async function handleWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  config: DashboardConfig,
  onTaskCompleted?: (taskId: string) => Promise<void> | void,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== WEBHOOK_PATH) return false;

  if (req.method?.toUpperCase() !== "POST") {
    jsonResponse(res, 405, {
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "POST only" },
    });
    return true;
  }

  if (!checkWebhookAuth(req, config)) {
    jsonResponse(res, 401, {
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Invalid webhook secret" },
    });
    return true;
  }

  let body: WebhookBody;
  try {
    const buf = await readBody(req);
    body = JSON.parse(buf.toString("utf-8")) as WebhookBody;
  } catch {
    jsonResponse(res, 400, {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" },
    });
    return true;
  }

  // Only process UPDATE events on the tasks table
  if (body.table !== "tasks") {
    jsonResponse(res, 200, { ok: true, data: { ignored: true, reason: "not tasks table" } });
    return true;
  }

  // Only act on transitions TO 'concluido'
  const wasAlreadyDone = body.old_record?.status === "concluido";
  const isNowDone = body.record?.status === "concluido";

  if (!isNowDone || wasAlreadyDone) {
    jsonResponse(res, 200, {
      ok: true,
      data: { ignored: true, reason: "no completion transition" },
    });
    return true;
  }

  const taskId = body.record?.id ?? "unknown";
  console.log(`[iris-dashboard] Task ${taskId} completed via webhook`);

  // Fire async notification without blocking the response
  if (onTaskCompleted) {
    Promise.resolve(onTaskCompleted(taskId)).catch((err: unknown) => {
      console.error("[iris-dashboard] Webhook onTaskCompleted error:", err);
    });
  }

  res.statusCode = 202;
  jsonResponse(res, 202, { ok: true, data: { accepted: true, event: "task_completed" } });
  return true;
}
