#!/usr/bin/env node
import { Command } from "commander";
import { downCommand } from "./commands/down.js";
import { initCommand } from "./commands/init.js";
import { printCommand } from "./commands/print.js";
import { upCommand } from "./commands/up.js";

const program = new Command();

program
  .name("openclaw-env")
  .description("Generate and run a hardened Docker Compose sandbox for OpenClaw")
  .version("0.1.0");

program
  .command("init")
  .description("Create openclaw.env.yml in the current directory")
  .option("--profile <profile>", "Preset: safe | dev | integrations")
  .option("--force", "Overwrite existing openclaw.env.yml", false)
  .action(async (opts) => {
    await initCommand({
      cwd: process.cwd(),
      profile: opts.profile as string | undefined,
      force: Boolean(opts.force),
    });
  });

program
  .command("print")
  .description("Print resolved permissions summary (no changes)")
  .option("--config <path>", "Path to openclaw.env.yml (default: ./openclaw.env.yml)")
  .action(async (opts) => {
    await printCommand({
      cwd: process.cwd(),
      configPath: opts.config as string | undefined,
    });
  });

program
  .command("up")
  .description("Generate sandbox files and run docker compose up")
  .option("--config <path>", "Path to openclaw.env.yml (default: ./openclaw.env.yml)")
  .option("--yes", "Skip confirmation prompts", false)
  .option("--attach", "Run docker compose up in the foreground", false)
  .option("--i-know-what-im-doing", "Acknowledge dangerous mounts", false)
  .option(
    "--accept-risk",
    "Acknowledge risk warnings (e.g. writable mounts with full network egress)",
    false,
  )
  .action(async (opts) => {
    await upCommand({
      cwd: process.cwd(),
      configPath: opts.config as string | undefined,
      yes: Boolean(opts.yes),
      attach: Boolean(opts.attach),
      iKnowWhatImDoing: Boolean(opts.iKnowWhatImDoing),
      acceptRisk: Boolean(opts.acceptRisk),
    });
  });

program
  .command("down")
  .description("Stop the sandbox (docker compose down)")
  .option("--config <path>", "Path to openclaw.env.yml (default: ./openclaw.env.yml)")
  .action(async (opts) => {
    await downCommand({
      cwd: process.cwd(),
      configPath: opts.config as string | undefined,
    });
  });

await program.parseAsync(process.argv);
