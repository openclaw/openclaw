import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, shouldStartCrestodianForBareRoot } from "../../src/cli/run-main.js";
import { clearConfigCache } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { runCrestodian } from "../../src/crestodian/crestodian.js";
import type { RuntimeEnv } from "../../src/runtime.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}

async function main() {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-first-run-")));
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  clearConfigCache();

  assert(
    shouldStartCrestodianForBareRoot(["node", "openclaw"]),
    "bare openclaw invocation did not route to Crestodian",
  );
  process.exitCode = undefined;
  await runCli(["node", "openclaw", "onboard", "--modern", "--non-interactive", "--json"]);
  assert(
    process.exitCode === undefined || process.exitCode === 0,
    "modern onboard overview exited nonzero",
  );

  const overviewRuntime = createRuntime();
  await runCrestodian({ message: "overview", interactive: false }, overviewRuntime.runtime);
  const overviewOutput = overviewRuntime.lines.join("\n");
  assert(
    overviewOutput.includes("Config: missing"),
    "fresh overview did not report missing config",
  );
  assert(
    overviewOutput.includes('Next: run "setup" to create a starter config'),
    "fresh overview did not include setup recommendation",
  );

  process.env.DISCORD_BOT_TOKEN = "openclaw-crestodian-discord-e2e-token";

  const setupRuntime = createRuntime();
  await runCrestodian(
    {
      message: "setup workspace /tmp/openclaw-first-run model openai/gpt-5.2",
      yes: true,
      interactive: false,
    },
    setupRuntime.runtime,
  );
  const setupOutput = setupRuntime.lines.join("\n");
  assert(
    setupOutput.includes("[crestodian] done: crestodian.setup"),
    "Crestodian setup did not apply",
  );

  clearConfigCache();
  const modelRuntime = createRuntime();
  await runCrestodian(
    {
      message: "set default model openai/gpt-5.2",
      yes: true,
      interactive: false,
    },
    modelRuntime.runtime,
  );
  assert(
    modelRuntime.lines.join("\n").includes("[crestodian] done: config.setDefaultModel"),
    "Crestodian default model update did not apply",
  );

  clearConfigCache();
  const agentRuntime = createRuntime();
  await runCrestodian(
    {
      message: "create agent reef workspace /tmp/openclaw-reef model openai/gpt-5.2",
      yes: true,
      interactive: false,
    },
    agentRuntime.runtime,
  );
  assert(
    agentRuntime.lines.join("\n").includes("[crestodian] done: agents.create"),
    "Crestodian agent creation did not apply",
  );

  clearConfigCache();
  const discordTokenRuntime = createRuntime();
  await runCrestodian(
    {
      message: "config set-ref channels.discord.token env DISCORD_BOT_TOKEN",
      yes: true,
      interactive: false,
    },
    discordTokenRuntime.runtime,
  );
  assert(
    discordTokenRuntime.lines.join("\n").includes("[crestodian] done: config.setRef"),
    "Crestodian Discord token SecretRef did not apply",
  );

  clearConfigCache();
  const discordEnabledRuntime = createRuntime();
  await runCrestodian(
    {
      message: "config set channels.discord.enabled true",
      yes: true,
      interactive: false,
    },
    discordEnabledRuntime.runtime,
  );
  assert(
    discordEnabledRuntime.lines.join("\n").includes("[crestodian] done: config.set"),
    "Crestodian Discord enabled flag did not apply",
  );

  clearConfigCache();
  const validateRuntime = createRuntime();
  await runCrestodian({ message: "validate config", interactive: false }, validateRuntime.runtime);
  assert(
    validateRuntime.lines.join("\n").includes("Config valid:"),
    "post-setup config validation did not pass",
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    config.agents?.defaults?.workspace === "/tmp/openclaw-first-run",
    "first-run setup did not write default workspace",
  );
  assert(
    config.agents?.defaults?.model &&
      typeof config.agents.defaults.model === "object" &&
      "primary" in config.agents.defaults.model &&
      config.agents.defaults.model.primary === "openai/gpt-5.2",
    "first-run setup did not write default model",
  );
  const reef = config.agents?.list?.find((agent) => agent.id === "reef");
  assert(reef, "Crestodian did not create reef agent");
  assert(reef.workspace === "/tmp/openclaw-reef", "Crestodian did not write reef workspace");
  assert(reef.model === "openai/gpt-5.2", "Crestodian did not write reef model");
  assert(config.channels?.discord?.enabled === true, "Crestodian did not enable Discord");
  const discordToken = config.channels?.discord?.token;
  assert(
    discordToken &&
      typeof discordToken === "object" &&
      "source" in discordToken &&
      discordToken.source === "env" &&
      "id" in discordToken &&
      discordToken.id === "DISCORD_BOT_TOKEN",
    "Crestodian did not write Discord token SecretRef",
  );
  assert(
    !JSON.stringify(config.channels.discord).includes(process.env.DISCORD_BOT_TOKEN),
    "Crestodian persisted the raw Discord token",
  );

  const auditPath = path.join(stateDir, "audit", "crestodian.jsonl");
  const audit = (await fs.readFile(auditPath, "utf8")).trim();
  assert(audit.includes('"operation":"crestodian.setup"'), "setup audit entry missing");
  assert(
    audit.includes('"operation":"config.setDefaultModel"'),
    "default model audit entry missing",
  );
  assert(audit.includes('"operation":"agents.create"'), "agent creation audit entry missing");
  assert(audit.includes('"operation":"config.setRef"'), "Discord SecretRef audit entry missing");
  assert(audit.includes('"operation":"config.set"'), "Discord enabled audit entry missing");

  console.log("Crestodian first-run Docker E2E passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
