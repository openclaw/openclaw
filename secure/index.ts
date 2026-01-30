/**
 * AssureBot - Entry Point
 *
 * Lean, secure, self-hosted AI assistant for Railway.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx ANTHROPIC_API_KEY=xxx ALLOWED_USERS=123 npx tsx secure/index.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadSecureConfig, validateConfig, redactConfig } from "./config.js";
import { createAuditLogger } from "./audit.js";
import { createAgent, createConversationStore } from "./agent.js";
import { createTelegramBot } from "./telegram.js";
import { createWebhookHandler } from "./webhooks.js";
import { createSandboxRunner } from "./sandbox.js";
import { createScheduler } from "./scheduler.js";

async function main() {
  console.log("=".repeat(50));
  console.log("  ASSUREBOT");
  console.log("  Lean, secure, self-hosted AI assistant");
  console.log("=".repeat(50));
  console.log();

  // Load configuration
  console.log("[init] Loading configuration...");
  const config = loadSecureConfig();

  // Validate and warn
  const warnings = validateConfig(config);
  if (warnings.length > 0) {
    console.log("[init] Configuration warnings:");
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  // Log redacted config
  console.log("[init] Configuration loaded:");
  console.log(JSON.stringify(redactConfig(config), null, 2));
  console.log();

  // Create audit logger
  console.log("[init] Creating audit logger...");
  const audit = createAuditLogger({
    enabled: config.audit.enabled,
    logPath: config.audit.logPath,
  });
  audit.startup();

  // Create AI agent
  console.log(`[init] Creating AI agent (${config.ai.provider})...`);
  const agent = createAgent(config, audit);

  // Create conversation store
  const conversations = createConversationStore();

  // Create Telegram bot
  console.log("[init] Creating Telegram bot...");
  const telegram = createTelegramBot({
    config,
    audit,
    agent,
    conversations,
  });

  // Create webhook handler
  console.log("[init] Creating webhook handler...");
  const webhooks = createWebhookHandler({
    config,
    audit,
    agent,
    telegramBot: telegram.bot,
  });

  // Create sandbox runner
  console.log("[init] Creating sandbox runner...");
  const sandbox = createSandboxRunner(config, audit);
  const sandboxAvailable = await sandbox.isAvailable();
  console.log(`[init] Sandbox available: ${sandboxAvailable}`);

  // Create scheduler
  console.log("[init] Creating scheduler...");
  const scheduler = createScheduler({
    config,
    audit,
    agent,
    telegramBot: telegram.bot,
  });

  // Create HTTP server
  console.log("[init] Creating HTTP server...");
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        telegram: "connected",
        sandbox: sandboxAvailable ? "available" : "unavailable",
      }));
      return;
    }

    // Readiness check
    if (url.pathname === "/ready") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("ready");
      return;
    }

    // Webhook handler
    if (await webhooks.handleRequest(req, res)) {
      return;
    }

    // 404 for everything else
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Not Found");
  });

  // Graceful shutdown
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[shutdown] Received ${signal}, shutting down...`);

    audit.shutdown();

    try {
      scheduler.stop();
      await telegram.stop();

      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      console.log("[shutdown] Shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] Error during shutdown:", err);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Start everything
  console.log("[start] Starting services...");

  // Start HTTP server
  server.listen(config.server.port, config.server.host, () => {
    console.log(`[start] HTTP server listening on ${config.server.host}:${config.server.port}`);
  });

  // Start scheduler
  scheduler.start();

  // Start Telegram bot (polling mode for simplicity)
  await telegram.start();

  console.log();
  console.log("=".repeat(50));
  console.log("  ASSUREBOT IS RUNNING");
  console.log();
  console.log(`  Telegram: Polling mode`);
  console.log(`  Webhooks: http://localhost:${config.server.port}${config.webhooks.basePath}/*`);
  console.log(`  Health:   http://localhost:${config.server.port}/health`);
  console.log(`  Allowed:  ${config.telegram.allowedUsers.length} users`);
  console.log();
  console.log("  Press Ctrl+C to stop");
  console.log("=".repeat(50));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
