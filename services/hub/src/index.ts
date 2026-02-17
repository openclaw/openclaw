import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { requireAuth } from "./auth/middleware.js";
import { initDb } from "./db/index.js";
import { loadEnv } from "./env.js";
import { createApiRoutes } from "./routes/api.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createCallbackRoute } from "./routes/callback.js";
import { createEventsRoute } from "./routes/events.js";
import { health } from "./routes/health.js";
import { createInstallRoute } from "./routes/install.js";
import { startSocketReceiver, stopSocketReceiver } from "./slack/socket-receiver.js";

const env = await loadEnv();

// Ensure data directory exists and initialise DB
mkdirSync(dirname(env.DB_PATH), { recursive: true });
initDb(env.DB_PATH);

const app = new Hono();

// Public routes
app.route("/", health);
app.route("/", createAuthRoutes(env));
app.route("/", createInstallRoute(env));
app.route("/", createCallbackRoute(env));
app.route("/", createEventsRoute(env));

// Protected API routes
app.use("/api/*", async (c, next) => {
  // Skip auth for /api/auth/* endpoints
  if (c.req.path.startsWith("/api/auth/")) {
    return next();
  }
  return requireAuth(c, next);
});
app.route("/", createApiRoutes(env));

// Serve admin dashboard static files
app.use("/*", serveStatic({ root: "./admin/dist" }));
// SPA fallback — serve index.html for unmatched routes
app.use("/*", serveStatic({ root: "./admin/dist", path: "index.html" }));

console.log(`hub service listening on port ${env.PORT}`);

serve({ fetch: app.fetch, port: env.PORT });

// Connect to Slack via Socket Mode to receive events
startSocketReceiver(env).catch((err) => {
  console.error("Failed to start Socket Mode receiver:", err);
});

// Graceful shutdown
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) {
      console.log(`Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down…`);

    // Force exit after 5s if disconnect hangs
    const forceTimer = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref();

    await stopSocketReceiver();
    process.exit(0);
  });
}
