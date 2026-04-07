/**
 * Discord bot for pipeline control.
 *
 * Commands:
 *   !start news          — trigger news pipeline
 *   !start tutorial X    — trigger tutorial pipeline with topic X
 *   !stop                — cancel running pipeline
 *   !status              — current pipeline state
 *   !preview             — scrape and show top articles
 *   !help                — show commands
 *
 * Setup:
 *   1. Create a bot at https://discord.com/developers/applications
 *   2. Enable MESSAGE CONTENT intent
 *   3. Add bot to your server with Send Messages + Read Messages permissions
 *   4. Set DISCORD_BOT_TOKEN in .env
 */

import { Client, GatewayIntentBits, type Message } from "discord.js";
import { runPipeline, loadConfig } from "../pipeline.js";
import { scrapeAll } from "../scraper/index.js";

let currentRun: { type: string; promise: Promise<unknown> } | null = null;

const COMMANDS: Record<string, string> = {
  "!help": "Show available commands",
  "!start news": "Run the news pipeline",
  '!start tutorial "topic"': "Run a tutorial pipeline",
  "!stop": "Cancel the running pipeline",
  "!status": "Check current pipeline state",
  "!preview": "Scrape and show top 5 articles",
};

async function handleMessage(message: Message) {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.startsWith("!")) return;

  const cmd = content.toLowerCase();

  // ── !help ──
  if (cmd === "!help") {
    const lines = Object.entries(COMMANDS)
      .map(([k, v]) => `\`${k}\` — ${v}`)
      .join("\n");
    await message.reply(`**Content Pipeline Commands:**\n${lines}`);
    return;
  }

  // ── !status ──
  if (cmd === "!status") {
    if (currentRun) {
      await message.reply(`⏳ Pipeline running: **${currentRun.type}**`);
    } else {
      await message.reply("💤 No pipeline running.");
    }
    return;
  }

  // ── !stop ──
  if (cmd === "!stop") {
    currentRun = null;
    await message.reply("🛑 Pipeline marked as stopped.");
    return;
  }

  // ── !preview ──
  if (cmd === "!preview") {
    await message.reply("📡 Scraping articles...");
    const config = loadConfig();
    const articles = await scrapeAll(config.sources);
    const top = articles
      .slice(0, 10)
      .map((a, i) => `**${i + 1}.** ${a.title} *(${a.source})*`)
      .join("\n");
    await message.reply(`📰 **Top Articles:**\n${top}`);
    return;
  }

  // ── !start news ──
  if (cmd === "!start news") {
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply("🚀 Starting news pipeline...");
    currentRun = {
      type: "news",
      promise: runPipeline({ pipelineType: "news" }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then((result) => {
          const uploads = (
            result as { uploads?: Array<{ platform: string; url?: string; status: string }> }
          ).uploads;
          const lines =
            uploads
              ?.map((u) =>
                u.url
                  ? `✅ ${u.platform}: ${u.url}`
                  : `${u.status === "success" ? "✅" : "❌"} ${u.platform}`,
              )
              .join("\n") ?? "No uploads";
          if ("send" in message.channel)
            message.channel.send(`✅ **Pipeline complete!**\n${lines}`).catch(() => {});
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **Pipeline failed:** ${(err as Error).message}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  // ── !start tutorial <topic> ──
  if (cmd.startsWith("!start tutorial ")) {
    const topic = content
      .slice("!start tutorial ".length)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!topic) {
      await message.reply('Usage: `!start tutorial "Your topic"`');
      return;
    }
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply(`🚀 Starting tutorial pipeline: **${topic}**...`);
    currentRun = {
      type: `tutorial: ${topic}`,
      promise: runPipeline({ pipelineType: "tutorial", topic }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then(() => {
          if ("send" in message.channel)
            message.channel.send("✅ **Tutorial pipeline complete!**").catch(() => {});
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **Tutorial failed:** ${(err as Error).message}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  // Unknown command
  if (content.startsWith("!")) {
    await message.reply(`Unknown command: \`${content}\`. Try \`!help\``);
  }
}

export function startDiscordBot(token: string) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("ready", () => {
    console.log(`\n🤖 Discord bot logged in as ${client.user?.tag}`);
    console.log("   Send !help in any channel to see commands\n");
  });

  client.on("messageCreate", (message) => {
    handleMessage(message).catch((err) => {
      console.error("Discord handler error:", err);
    });
  });

  client.login(token);
  return client;
}
