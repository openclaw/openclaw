/**
 * Azure Function entry point for OpenClaw serverless deployment.
 *
 * Node.js v4 programming model – uses `app.http()` to register an HTTP trigger
 * that receives webhook payloads from Telegram (and optionally other channels).
 *
 * The function is completely stateless: every invocation reads configuration
 * from environment variables and persists state via Azure Table Storage
 * (memory) and Azure Blob Storage (sessions).
 *
 * Environment variables (set via Bicep / App Settings):
 *   TELEGRAM_BOT_TOKEN       – Telegram bot token
 *   TELEGRAM_WEBHOOK_SECRET  – webhook secret for request validation
 *   GITHUB_TOKEN             – GitHub Copilot API token (via Key Vault reference)
 *   AZURE_STORAGE_CONNECTION_STRING – Azure Storage connection string
 *   OPENCLAW_AGENT_ID        – agent identifier (default: "default")
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { Bot, webhookCallback } from "grammy";

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Telegram bot (lazy singleton – reused across warm invocations)
// ---------------------------------------------------------------------------

let _bot: Bot | undefined;

function getTelegramBot(): Bot {
  if (_bot) return _bot;

  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  _bot = new Bot(token);

  // Minimal echo handler – replace with full OpenClaw reply pipeline as needed.
  _bot.on("message:text", async (ctx) => {
    const userMessage = ctx.message.text;
    const agentId = process.env.OPENCLAW_AGENT_ID ?? "default";

    // Acknowledge receipt while the model thinks.
    await ctx.reply(`[${agentId}] Received your message. Processing…`);

    // -----------------------------------------------------------------
    // Provider integration placeholder
    //
    // In a full deployment you would import the OpenClaw reply pipeline
    // (e.g. `dispatchInboundMessage` → `runReplyAgent`) and route the
    // message through the configured provider.
    //
    // For GitHub Copilot API:
    //   const token = process.env.GITHUB_TOKEN;
    //   const response = await fetch("https://api.githubcopilot.com/chat/completions", {
    //     method: "POST",
    //     headers: {
    //       Authorization: `Bearer ${token}`,
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify({
    //       model: "gpt-4o",
    //       messages: [{ role: "user", content: userMessage }],
    //     }),
    //   });
    //   const data = await response.json();
    //   await ctx.reply(data.choices?.[0]?.message?.content ?? "No response");
    // -----------------------------------------------------------------
  });

  return _bot;
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function telegramWebhook(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  context.log("Telegram webhook invoked", request.method, request.url);

  // Health-check endpoint
  if (request.url.endsWith("/healthz")) {
    return { status: 200, body: "ok" };
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const bot = getTelegramBot();

  try {
    // grammy's webhookCallback returns a handler for the Node http module.
    // In Azure Functions v4 we need to adapt the request/response ourselves.
    const body = await request.text();
    const update = JSON.parse(body);

    // Validate secret token header when configured.
    if (secret) {
      const headerSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (headerSecret !== secret) {
        context.warn("Telegram webhook secret mismatch");
        return { status: 401, body: "Unauthorized" };
      }
    }

    // Process the update through grammy.
    await bot.handleUpdate(update);

    return { status: 200, body: "ok" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    context.error("Webhook processing failed:", message);
    return { status: 500, body: "Internal Server Error" };
  }
}

// ---------------------------------------------------------------------------
// Register HTTP trigger
// ---------------------------------------------------------------------------

app.http("telegram-webhook", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "telegram-webhook",
  handler: telegramWebhook,
});

app.http("healthz", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "healthz",
  handler: async () => ({ status: 200, body: "ok" }),
});
