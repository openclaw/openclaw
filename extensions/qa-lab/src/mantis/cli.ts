import type { Command } from "commander";
import { createLazyCliRuntimeLoader } from "../live-transports/shared/live-transport-cli.js";
import type { MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";

type MantisCliRuntime = typeof import("./cli.runtime.js");

const loadMantisCliRuntime = createLazyCliRuntimeLoader<MantisCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runDiscordSmoke(opts: MantisDiscordSmokeOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisDiscordSmokeCommand(opts);
}

type MantisDiscordSmokeCommanderOptions = {
  channelId?: string;
  guildId?: string;
  message?: string;
  outputDir?: string;
  repoRoot?: string;
  skipPost?: boolean;
  tokenFile?: string;
  tokenFileEnv?: string;
  tokenEnv?: string;
};

export function registerMantisCli(qa: Command) {
  const mantis = qa
    .command("mantis")
    .description("Run Mantis before/after and live-smoke verification flows");

  mantis
    .command("discord-smoke")
    .description("Verify the Mantis Discord bot can see the guild/channel, post, and react")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis Discord smoke artifact directory")
    .option("--guild-id <id>", "Override OPENCLAW_QA_DISCORD_GUILD_ID")
    .option("--channel-id <id>", "Override OPENCLAW_QA_DISCORD_CHANNEL_ID")
    .option("--token-env <name>", "Env var containing the Mantis Discord bot token")
    .option("--token-file <path>", "File containing the Mantis Discord bot token")
    .option("--token-file-env <name>", "Env var containing the Mantis Discord bot token file path")
    .option("--message <text>", "Smoke message to post")
    .option("--skip-post", "Only check Discord API visibility; do not post or react", false)
    .action(async (opts: MantisDiscordSmokeCommanderOptions) => {
      await runDiscordSmoke({
        channelId: opts.channelId,
        guildId: opts.guildId,
        message: opts.message,
        outputDir: opts.outputDir,
        repoRoot: opts.repoRoot,
        skipPost: opts.skipPost,
        tokenFile: opts.tokenFile,
        tokenFileEnv: opts.tokenFileEnv,
        tokenEnv: opts.tokenEnv,
      });
    });
}
