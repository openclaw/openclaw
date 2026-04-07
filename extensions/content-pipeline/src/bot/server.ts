/**
 * Zalo OA webhook server for pipeline control.
 *
 * Supported commands:
 *   start news          — trigger news pipeline
 *   start tutorial X    — trigger tutorial pipeline with topic X
 *   stop                — cancel running pipeline
 *   status              — current pipeline state
 *   preview             — scrape and show top articles
 *   help                — show commands
 */

import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runPipeline, loadConfig } from "../pipeline.js";
import { scrapeAll } from "../scraper/index.js";
import { sendMessage } from "./notifier.js";

interface BotConfig {
  port: number;
  oaAccessToken: string;
  oaSecretKey: string;
  allowedUserIds: string[];
}

let currentRun: { type: string; promise: Promise<unknown> } | null = null;

function verifySignature(body: string, signature: string, secretKey: string): boolean {
  const expected = createHmac("sha256", secretKey).update(body).digest("hex");
  return expected === signature;
}

async function handleCommand(userId: string, message: string, config: BotConfig) {
  const reply = (text: string) => sendMessage(userId, text, config.oaAccessToken);
  const cmd = message.trim().toLowerCase();

  if (cmd === "help") {
    await reply(
      `Available commands:\n` +
        `  start news — run news pipeline\n` +
        `  start tutorial <topic> — run tutorial pipeline\n` +
        `  stop — cancel current run\n` +
        `  status — check pipeline state\n` +
        `  preview — show top articles\n` +
        `  help — this message`,
    );
    return;
  }

  if (cmd === "status") {
    if (currentRun) {
      await reply(`⏳ Pipeline running: ${currentRun.type}`);
    } else {
      await reply("💤 No pipeline running.");
    }
    return;
  }

  if (cmd === "stop") {
    // Note: true cancellation would need AbortController threading
    currentRun = null;
    await reply("🛑 Pipeline marked as stopped.");
    return;
  }

  if (cmd === "preview") {
    const pipelineConfig = loadConfig();
    const articles = await scrapeAll(pipelineConfig.sources);
    const top5 = articles
      .slice(0, 5)
      .map((a, i) => `${i + 1}. ${a.title} (${a.source}, ${a.score}pts)`)
      .join("\n");
    await reply(`📰 Top articles:\n${top5}`);
    return;
  }

  if (cmd.startsWith("start news")) {
    if (currentRun) {
      await reply("⚠️ A pipeline is already running. Send 'stop' first.");
      return;
    }
    await reply("🚀 Starting news pipeline...");
    currentRun = {
      type: "news",
      promise: runPipeline({ pipelineType: "news" })
        .then(() => reply("✅ News pipeline complete!"))
        .catch((err) => reply(`❌ News pipeline failed: ${(err as Error).message}`))
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  if (cmd.startsWith("start tutorial ")) {
    const topic = message.trim().slice("start tutorial ".length).trim();
    if (!topic) {
      await reply("Usage: start tutorial <topic>");
      return;
    }
    if (currentRun) {
      await reply("⚠️ A pipeline is already running. Send 'stop' first.");
      return;
    }
    await reply(`🚀 Starting tutorial pipeline: "${topic}"...`);
    currentRun = {
      type: `tutorial: ${topic}`,
      promise: runPipeline({ pipelineType: "tutorial", topic })
        .then(() => reply("✅ Tutorial pipeline complete!"))
        .catch((err) => reply(`❌ Tutorial pipeline failed: ${(err as Error).message}`))
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  await reply(`Unknown command: "${message}". Send 'help' for available commands.`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function startBot(botConfig: BotConfig) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    // Webhook
    if (req.method === "POST" && req.url === "/webhook") {
      const body = await readBody(req);
      const signature = req.headers["x-hub-signature"] as string | undefined;

      if (signature && !verifySignature(body, signature, botConfig.oaSecretKey)) {
        res.writeHead(403);
        res.end("Invalid signature");
        return;
      }

      try {
        const event = JSON.parse(body);

        if (event.event === "user_send_text") {
          const userId = event.user_id as string;

          // Check allowed users
          if (botConfig.allowedUserIds.length > 0 && !botConfig.allowedUserIds.includes(userId)) {
            res.writeHead(200);
            res.end("ok");
            return;
          }

          // Handle command in background
          handleCommand(userId, event.message as string, botConfig).catch(console.error);
        }
      } catch (err) {
        console.error("Webhook parse error:", err);
      }

      res.writeHead(200);
      res.end("ok");
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(botConfig.port, () => {
    console.log(`\n🤖 Zalo bot listening on port ${botConfig.port}`);
    console.log(`   Webhook URL: http://localhost:${botConfig.port}/webhook`);
    console.log(`   Health check: http://localhost:${botConfig.port}/health\n`);
  });

  return server;
}
