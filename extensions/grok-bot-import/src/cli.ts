import type { Command } from "commander";
import { addGatewayClientOptions, type GatewayRpcOpts } from "openclaw/plugin-sdk/gateway-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { resolveGrokBotAccessToken } from "./auth.js";
import { GrokBotClient } from "./client.js";
import { importGrokBots, installConvertedPackage } from "./import.js";
import { discoverGrokBotRoster } from "./local.js";

type ImportOptions = GatewayRpcOpts & { out: string; all?: boolean; install?: boolean };

function reportError(error: unknown): void {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Grok Bot import failed.")}\n`,
  );
  process.exitCode = 1;
}

export function registerGrokBotCli(program: Command): void {
  const grok = program
    .command("grok-bot")
    .description("Discover Grok bots and convert complete recipes to portable Claws");
  addGatewayClientOptions(
    grok
      .command("install")
      .description("Install an already converted Claw package on this gateway machine")
      .argument("<directory>", "Converted Claw package directory")
      .option("--json", "Print JSON", false),
  ).action(async (directory: string, options: GatewayRpcOpts) => {
    try {
      const agentId = await installConvertedPackage(directory, options);
      process.stdout.write(`${JSON.stringify({ status: "installed", agentId }, null, 2)}\n`);
    } catch (error) {
      reportError(error);
    }
  });
  grok
    .command("list")
    .description("Discover locally cached bots, or read the signed-in account's full roster")
    .option("--online", "List hosted bots using your signed-in Grok Bot account", false)
    .option("--from <path>", "Grok Bot application data directory")
    .option("--json", "Print JSON", false)
    .action(async (options: { online?: boolean; from?: string; json?: boolean }) => {
      try {
        const result = options.online
          ? { bots: await new GrokBotClient(await resolveGrokBotAccessToken()).listBots() }
          : await discoverGrokBotRoster({ root: options.from });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        reportError(error);
      }
    });
  addGatewayClientOptions(
    grok
      .command("import")
      .description("Convert a Grok recipe or URL; optionally install the resulting Claw agents")
      .argument("[source]", "Recipe JSON file, marketplace URL, or bot share URL")
      .option(
        "--all",
        "Import available content from every owned Grok bot, with explicit missing-source warnings",
        false,
      )
      .requiredOption("--out <directory>", "New directory for the converted Claw package(s)")
      .option("--install", "Add converted Claws as agents through the running local gateway", false)
      .option("--json", "Print JSON", false),
  ).action(async (source: string | undefined, options: ImportOptions) => {
    try {
      const results = await importGrokBots({
        source,
        all: options.all,
        out: options.out,
        install: options.install,
        gateway: options,
        resolveAccessToken: () => resolveGrokBotAccessToken(),
      });
      process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
      if (results.some((result) => result.status === "failed")) {
        process.exitCode = 1;
      }
    } catch (error) {
      reportError(error);
    }
  });
}
