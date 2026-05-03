import type { Command } from "commander";
import { createLazyCliRuntimeLoader } from "../live-transports/shared/live-transport-cli.js";
import type { MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";
import type { MantisBeforeAfterOptions } from "./run.runtime.js";

type MantisCliRuntime = typeof import("./cli.runtime.js");

const loadMantisCliRuntime = createLazyCliRuntimeLoader<MantisCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runDiscordSmoke(opts: MantisDiscordSmokeOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisDiscordSmokeCommand(opts);
}

async function runBeforeAfter(opts: MantisBeforeAfterOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisBeforeAfterCommand(opts);
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

type MantisBeforeAfterCommanderOptions = {
  baseline?: string;
  candidate?: string;
  credentialRole?: string;
  credentialSource?: string;
  fast?: boolean;
  outputDir?: string;
  providerMode?: string;
  repoRoot?: string;
  scenario?: string;
  skipBuild?: boolean;
  skipInstall?: boolean;
  transport?: string;
};

export function registerMantisCli(qa: Command) {
  const mantis = qa
    .command("mantis")
    .description("Run Mantis before/after and live-smoke verification flows");

  mantis
    .command("run")
    .description("Run a Mantis before/after scenario against baseline and candidate refs")
    .requiredOption("--transport <transport>", "Transport to verify; currently only discord")
    .requiredOption("--scenario <id>", "Mantis scenario id to run")
    .requiredOption("--baseline <ref>", "Ref expected to reproduce the bug")
    .requiredOption("--candidate <ref>", "Ref expected to contain the fix")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis before/after artifact directory")
    .option("--provider-mode <mode>", "QA provider mode", "live-frontier")
    .option("--credential-source <source>", "QA credential source", "convex")
    .option("--credential-role <role>", "QA credential role", "ci")
    .option("--fast", "Enable fast provider mode where supported", true)
    .option("--skip-install", "Skip pnpm install in baseline/candidate worktrees", false)
    .option("--skip-build", "Skip pnpm build in baseline/candidate worktrees", false)
    .action(async (opts: MantisBeforeAfterCommanderOptions) => {
      await runBeforeAfter({
        baseline: opts.baseline,
        candidate: opts.candidate,
        credentialRole: opts.credentialRole,
        credentialSource: opts.credentialSource,
        fastMode: opts.fast,
        outputDir: opts.outputDir,
        providerMode: opts.providerMode,
        repoRoot: opts.repoRoot,
        scenario: opts.scenario,
        skipBuild: opts.skipBuild,
        skipInstall: opts.skipInstall,
        transport: opts.transport,
      });
    });

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
