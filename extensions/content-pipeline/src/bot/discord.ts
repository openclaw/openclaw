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
import { scrapeAll } from "../steps/01-scrape/index.js";

let currentRun: { type: string; promise: Promise<unknown> } | null = null;

const COMMANDS: Record<string, string> = {
  "!help": "Show available commands",
  "!preview": "Scrape and show top 10 articles (Step 1)",
  "!concept": "Scrape + score + pick concept (Steps 1+2, ~30s)",
  "!related": "Scrape + concept + fetch related sources (Steps 1+2+3, ~45s)",
  "!script": "Scrape + concept + related + deep-dive script (Steps 1+2+3+4, ~60s)",
  "!tts": "Full script + TTS narration (Steps 1-5, ~90s)",
  "!video": "Full pipeline through video render (Steps 1-6, ~3min)",
  "!start news": "Run the full news pipeline (Steps 1-7)",
  '!start tutorial "topic"': "Run a tutorial pipeline",
  "!stop": "Cancel the running pipeline",
  "!status": "Check current pipeline state",
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
    const articles = await scrapeAll(config.sources, {
      poolSize: config.content.poolSize,
      maxPerSource: config.content.maxPerSource,
    });
    const top = articles
      .slice(0, 10)
      .map((a, i) => `**${i + 1}.** ${a.title} *(${a.source})*`)
      .join("\n");
    await message.reply(`📰 **Top Articles:**\n${top}`);
    return;
  }

  // ── !video ── full pipeline through video render (Steps 1–6)
  if (cmd === "!video") {
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply("🎬 Running full pipeline through video render...");
    currentRun = {
      type: "video",
      promise: runPipeline({ pipelineType: "news", stopAtStage: "video" }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then((result) => {
          const r = result as {
            content?: { videoTitle: string };
            videoResult?: { landscapePath: string; portraitPath: string; durationSeconds: number };
          };
          if (r.videoResult && "send" in message.channel) {
            const v = r.videoResult;
            const dur = `${Math.floor(v.durationSeconds / 60)}m ${Math.floor(v.durationSeconds % 60)}s`;
            message.channel
              .send(
                `✅ **Video ready** — "${r.content?.videoTitle ?? "untitled"}"\n📐 Landscape: ${v.landscapePath.split("/").slice(-2).join("/")}\n📱 Portrait: ${v.portraitPath.split("/").slice(-2).join("/")}\n⏱️ ${dur}`,
              )
              .catch(() => {});
          }
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **Video run failed:** ${(err as Error).message.slice(0, 200)}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  // ── !tts ── scrape + concept + related + script + TTS (Steps 1–5)
  if (cmd === "!tts") {
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply("🎙️ Running full pipeline through TTS...");
    currentRun = {
      type: "tts",
      promise: runPipeline({ pipelineType: "news", stopAtStage: "slides" }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then((result) => {
          const r = result as {
            content?: { videoTitle: string; slides: Array<{ title: string }> };
            audioSegments?: Array<{ audioPath: string; durationSeconds: number }>;
          };
          if (r.content && r.audioSegments && "send" in message.channel) {
            const total = r.audioSegments.reduce((s, a) => s + a.durationSeconds, 0);
            const breakdown = r.audioSegments
              .map(
                (a, i) =>
                  `${i + 1}. ${r.content!.slides[i]?.title ?? "?"} — ${a.durationSeconds.toFixed(1)}s`,
              )
              .join("\n");
            message.channel
              .send(
                `✅ **Audio ready** — "${r.content.videoTitle}"\n⏱️ Total: ${Math.floor(total / 60)}m ${Math.floor(total % 60)}s\n\n${breakdown}`,
              )
              .catch(() => {});
          }
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **TTS run failed:** ${(err as Error).message.slice(0, 200)}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  // ── !script ── scrape + concept + related + deep-dive script (Steps 1–4)
  if (cmd === "!script") {
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply("✍️ Running scrape + concept + related + script...");
    currentRun = {
      type: "script",
      promise: runPipeline({ pipelineType: "news", stopAtStage: "content" }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then((result) => {
          const r = result as {
            content?: {
              videoTitle: string;
              slides: Array<{ slideType: string; title: string; speakerNotes: string }>;
            };
          };
          if (r.content && "send" in message.channel) {
            const v = r.content;
            const intro = v.slides.find((s) => s.slideType === "intro");
            const slideList = v.slides
              .map((s, i) => `${i + 1}. **${s.title}** \`${s.slideType}\``)
              .join("\n");
            message.channel
              .send(
                `✅ **Script ready** — "${v.videoTitle}" (${v.slides.length} slides)\n\n${slideList}\n\n🎬 **Intro narration:** ${(intro?.speakerNotes ?? "").slice(0, 300)}`,
              )
              .catch(() => {});
          }
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **Script run failed:** ${(err as Error).message.slice(0, 200)}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  // ── !related ── scrape + concept + related-source fetch (Steps 1 + 2 + 3)
  if (cmd === "!related") {
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply("📚 Running scrape + concept + related sources...");
    currentRun = {
      type: "related",
      promise: runPipeline({ pipelineType: "news", stopAtStage: "scrape" }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then((result) => {
          const r = result as {
            concept?: { title: string; theme: string; keywords: string[] };
            relatedSources?: Array<{
              title: string;
              source: string;
              fullText: string;
              fetchOk: boolean;
              keywordMatches: number;
              fetchError?: string;
            }>;
          };
          if (r.relatedSources && "send" in message.channel) {
            const ok = r.relatedSources.filter((s) => s.fetchOk).length;
            const total = r.relatedSources.length;
            const totalChars = r.relatedSources.reduce((s, a) => s + a.fullText.length, 0);
            message.channel
              .send(
                `✅ **Related ready** — ${ok}/${total} fetched, ${totalChars} chars total\n🎯 ${r.concept?.title ?? "(no concept)"}`,
              )
              .catch(() => {});
          }
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **Related run failed:** ${(err as Error).message.slice(0, 200)}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
    return;
  }

  // ── !concept ── scrape + concept selection only (Step 1 + Step 2)
  if (cmd === "!concept") {
    if (currentRun) {
      await message.reply("⚠️ A pipeline is already running. Send `!stop` first.");
      return;
    }
    await message.reply("🎯 Running scrape + concept selection...");
    currentRun = {
      type: "concept",
      promise: runPipeline({ pipelineType: "news", stopAtStage: "scrape" }, (event) => {
        if ("send" in message.channel)
          message.channel.send(`📦 **${event.stage}**: ${event.message}`).catch(() => {});
      })
        .then((result) => {
          const r = result as { concept?: { title: string; theme: string; keywords: string[] } };
          if (r.concept && "send" in message.channel) {
            message.channel
              .send(
                `✅ **Concept ready**\n🎯 ${r.concept.title}\n_${r.concept.theme}_\n🔑 ${r.concept.keywords.join(", ")}`,
              )
              .catch(() => {});
          }
        })
        .catch((err) => {
          if ("send" in message.channel)
            message.channel
              .send(`❌ **Concept run failed:** ${(err as Error).message.slice(0, 200)}`)
              .catch(() => {});
        })
        .finally(() => {
          currentRun = null;
        }),
    };
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
    console.log(`   App ID: ${client.user?.id}`);
    const guilds = client.guilds.cache;
    console.log(`   In ${guilds.size} guild(s):`);
    for (const [, g] of guilds) {
      console.log(`     - ${g.name} (${g.id}) — ${g.channels.cache.size} channels`);
    }
    if (guilds.size === 0) {
      console.log("\n   ⚠ Bot is not in any server. Invite it with:");
      console.log(
        `   https://discord.com/api/oauth2/authorize?client_id=${client.user?.id}&permissions=2147485696&scope=bot`,
      );
    }
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
