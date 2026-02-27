import type { IncomingMessage } from "node:http";
import type { DashboardConfig } from "./config.js";

/** Validates auth for mutable endpoints (POST/PATCH/DELETE).
 *  Accepts Bearer token or X-Iris-Dashboard-Key header. */
export function checkMutableAuth(req: IncomingMessage, config: DashboardConfig): boolean {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7) === config.dashboardApiKey;
  }
  const key = req.headers["x-iris-dashboard-key"];
  if (typeof key === "string") {
    return key === config.dashboardApiKey;
  }
  return false;
}

/** Validates the shared secret for Supabase webhook calls. */
export function checkWebhookAuth(req: IncomingMessage, config: DashboardConfig): boolean {
  const secret = req.headers["x-iris-webhook-secret"];
  return typeof secret === "string" && secret === config.webhookSecret;
}
