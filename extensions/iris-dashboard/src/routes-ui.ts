import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DASHBOARD_PATH = "/iris-dashboard";
const HEALTH_PATH = "/iris-dashboard/health";

const VERSION = "1.0.0";

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(payload);
}

/** Build cached HTML with injected Supabase config. */
function buildHtml(config: DashboardConfig): string {
  const templatePath = join(__dirname, "..", "ui", "index.html");
  const template = readFileSync(templatePath, "utf-8");
  const clientConfig = JSON.stringify({
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseAnonKey ?? config.supabaseServiceKey,
    apiBase: "/iris-dashboard/api",
  });
  return template.replace(
    "<!-- __IRIS_DASHBOARD_CONFIG__ -->",
    `<script>window.__IRIS_DASHBOARD_CONFIG__ = ${clientConfig};</script>`,
  );
}

let cachedHtml: string | null = null;

export function createUiHandler(config: DashboardConfig) {
  /** Handle UI and health routes. Returns true if handled. */
  return function handleUiRoutes(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Health check
    if (pathname === HEALTH_PATH) {
      jsonResponse(res, 200, { ok: true, data: { service: "iris-dashboard", version: VERSION } });
      return true;
    }

    // Dashboard UI — serve static files too (styles.css, app.js, api.js)
    if (pathname === DASHBOARD_PATH || pathname === `${DASHBOARD_PATH}/`) {
      if (req.method?.toUpperCase() !== "GET") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return true;
      }
      if (!cachedHtml) {
        cachedHtml = buildHtml(config);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.statusCode = 200;
      res.end(cachedHtml);
      return true;
    }

    // Serve static UI assets (styles.css, app.js, api.js)
    const assetPrefix = `${DASHBOARD_PATH}/`;
    if (pathname.startsWith(assetPrefix)) {
      const assetName = pathname.slice(assetPrefix.length);
      // Only allow safe filenames for static assets
      if (/^[\w.-]+\.(css|js)$/.test(assetName)) {
        try {
          const assetPath = join(__dirname, "..", "ui", assetName);
          const content = readFileSync(assetPath, "utf-8");
          const ct = assetName.endsWith(".css") ? "text/css" : "application/javascript";
          res.setHeader("Content-Type", `${ct}; charset=utf-8`);
          res.setHeader("Cache-Control", "public, max-age=60");
          res.statusCode = 200;
          res.end(content);
          return true;
        } catch {
          // Not a static asset — let other handlers deal with it
        }
      }
    }

    return false;
  };
}
