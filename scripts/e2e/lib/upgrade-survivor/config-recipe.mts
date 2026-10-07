#!/usr/bin/env node
// Builds config recipes for upgrade-survivor E2E scenarios.
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareReleaseVersions,
  parsePinnedReleaseVersion,
} from "../../../lib/release-version.mjs";
import { usesStructuredToolSearchAtBaseline } from "../../../lib/upgrade-survivor-policy.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../../../windows-cmd-helpers.mjs";

const args = process.argv.slice(2);
const command = args.shift();
export const CONFIG_COMMAND_TIMEOUT_MS = 120_000;
export const CONFIG_COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type ConfigStep = {
  id: string;
  intent: string;
  intents?: string[];
  argv: string[];
  prepublishPluginPackages?: string[];
};

type UpgradeSurvivorCommandParams = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};
type SpawnSyncCommand = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stderr" | "stdout">;
type ConfigCommandParams = {
  maxBufferBytes?: number;
  spawnSyncCommand?: SpawnSyncCommand;
  timeoutMs?: number;
};

function option(name: string): string;
function option<T>(name: string, fallback: T): string | T;
function option<T>(name: string, fallback?: T) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

function tail(text: string, max = 2400) {
  return text.length <= max ? text : text.slice(-max);
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const configSectionDir = new URL("./config-recipe/", import.meta.url);

function readConfigSection(fileName: string) {
  const fileUrl = new URL(fileName, configSectionDir);
  return JSON.stringify(JSON.parse(fs.readFileSync(fileUrl, "utf8")));
}

function configSetJsonFile(
  id: string,
  intent: string,
  configPath: string,
  fileName = `${id}.json`,
): ConfigStep {
  return {
    id,
    intent,
    argv: ["config", "set", configPath, readConfigSection(fileName), "--strict-json"],
  };
}

const representativeConfigSteps: ConfigStep[] = [
  configSetJsonFile("models-openai", "models", "models.providers.openai"),
  configSetJsonFile("models-anthropic", "models-anthropic", "models.providers.anthropic"),
  configSetJsonFile("models-google", "models-google", "models.providers.google"),
  // Keep the migration specimen idle while baseline and candidate services run:
  // a heartbeat refreshes its skills snapshot before inference, even when auth fails.
  configSetJsonFile("agents", "agents", "agents"),
  configSetJsonFile("skills", "skills", "skills"),
  configSetJsonFile("plugins", "plugins", "plugins"),
  configSetJsonFile("channels-discord", "discord-channel", "channels.discord"),
  configSetJsonFile("channels-telegram", "telegram-channel", "channels.telegram"),
  configSetJsonFile("channels-whatsapp", "whatsapp-channel", "channels.whatsapp"),
  configSetJsonFile("tools-tool-search", "tool-search", "tools.toolSearch"),
];

const configuredPluginInstallSteps = [
  configSetJsonFile("plugins-configured-installs", "configured-plugin-installs", "plugins"),
  {
    id: "channels-whatsapp-unset",
    intent: "configured-plugin-installs",
    argv: ["config", "unset", "channels.whatsapp"],
  },
  configSetJsonFile("channels-matrix", "configured-plugin-installs", "channels.matrix"),
];

const scenarioConfigSteps = new Map<string, ConfigStep[]>([
  [
    "base",
    [
      {
        id: "logging-file",
        intent: "logging",
        // Raw debug output stays in the isolated home, outside uploaded artifact roots.
        argv: ["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"],
      },
      {
        id: "logging-level",
        intent: "logging",
        argv: ["config", "set", "logging.level", "debug"],
      },
    ],
  ],
  [
    "acpx-openclaw-tools-bridge",
    [
      {
        ...configSetJsonFile(
          "plugins-acpx-openclaw-tools-bridge",
          "acpx-openclaw-tools-bridge",
          "plugins",
        ),
        // The candidate externalizes this runtime even when the baseline bundles it.
        prepublishPluginPackages: ["@openclaw/acpx"],
      },
    ],
  ],
  [
    "feishu-channel",
    [
      configSetJsonFile("plugins-feishu", "plugins", "plugins"),
      configSetJsonFile("channels-feishu", "feishu-channel", "channels.feishu"),
    ],
  ],
  [
    "tilde-log-path",
    [
      {
        id: "logging-file",
        intent: "logging",
        argv: ["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"],
      },
    ],
  ],
  ["configured-plugin-installs", configuredPluginInstallSteps],
  ["sqlite-volume", configuredPluginInstallSteps],
  [
    "codex-allowlist-survival",
    [
      {
        id: "plugins-codex-allowlist",
        intent: "codex-allowlist-survival",
        argv: [
          "config",
          "set",
          "plugins.allow",
          JSON.stringify([
            "anthropic",
            "google",
            "openai",
            "discord",
            "memory",
            "telegram",
            "whatsapp",
            "codex",
          ]),
          "--strict-json",
        ],
      },
    ],
  ],
]);

export function resolveScenarioConfigSteps(scenario: string): ConfigStep[] {
  return scenarioConfigSteps.get(scenario) ?? [];
}

const sharedRecipe: ConfigStep[] = [
  configSetJsonFile("gateway", "gateway", "gateway"),
  ...representativeConfigSteps,
];
const validateStep: ConfigStep = {
  id: "validate",
  intent: "validate",
  argv: ["config", "validate"],
};

const connectionOnlySharedIntents = new Set(["gateway"]);
const connectionOnlyScenarios = new Set(["mobile-pairing-reconnect", "watchos-direct-node"]);

export function resolveUpgradeSurvivorConfigSteps(
  scenario = "base",
  configuredUpdateChannel = process.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL,
): ConfigStep[] {
  const updateChannel =
    configuredUpdateChannel || (scenario === "prerelease-plugin-registry" ? "beta" : "stable");
  if (updateChannel !== "stable" && updateChannel !== "beta") {
    throw new Error(`invalid upgrade survivor update channel: ${updateChannel}`);
  }
  const toolSearchRecipe =
    process.env.OPENCLAW_FROZEN_UPGRADE_SURVIVOR_TOOL_SEARCH_RECIPE ?? "current";
  if (toolSearchRecipe !== "current" && toolSearchRecipe !== "absent") {
    throw new Error(`invalid selected Tool Search recipe: ${toolSearchRecipe}`);
  }
  const sharedSteps = sharedRecipe
    .filter((step) => step.intent !== "tool-search" || toolSearchRecipe === "current")
    .filter(
      (step) =>
        !connectionOnlyScenarios.has(scenario) || connectionOnlySharedIntents.has(step.intent),
    )
    .map((step) => {
      if (scenario === "mobile-pairing-reconnect" && step.id === "gateway") {
        return configSetJsonFile("gateway", "gateway", "gateway", "gateway-password.json");
      }
      if (scenario !== "recovery-cleanup" || step.id !== "agents") {
        return step;
      }
      const agentsJson = step.argv[3];
      if (agentsJson === undefined) {
        throw new Error(`config recipe step ${step.id} is missing its JSON value`);
      }
      // Extend the canonical roster before the baseline adapter chooses entries or legacy list.
      // A second agents.list write bypasses that version contract and can lose ownership defaults.
      const agents = JSON.parse(agentsJson);
      agents.entries["recovery-clean"] = { workspace: "~/workspace/recovery-clean" };
      agents.entries["recovery-protected"] = { workspace: "~/workspace/recovery-protected" };
      const argv = [...step.argv.slice(0, 3), JSON.stringify(agents), ...step.argv.slice(4)];
      return Object.assign({}, step, { argv });
    });
  return [
    {
      id: "update-channel",
      intent: "update",
      argv: ["config", "set", "update.channel", updateChannel],
    },
    ...sharedSteps,
    ...resolveScenarioConfigSteps(scenario),
    validateStep,
  ];
}

function adaptStepForBaseline(step: ConfigStep, baselineVersion: string | null): ConfigStep {
  if (step.id === "tools-tool-search" && usesStructuredToolSearchAtBaseline(baselineVersion)) {
    return {
      ...step,
      argv: [...step.argv.slice(0, 3), JSON.stringify({ mode: "tools" }), ...step.argv.slice(4)],
    };
  }
  if (step.id === "agents") {
    const agentsJson = step.argv[3];
    if (agentsJson === undefined) {
      throw new Error(`config recipe step ${step.id} is missing its JSON value`);
    }
    const agents = JSON.parse(agentsJson);
    // Keyed rosters shipped before explicit ownership; those baselines still
    // require the legacy default marker.
    if (compareReleaseVersions(baselineVersion ?? "", "2026.8.1-beta.2") === -1) {
      agents.entries.main.default = true;
      delete agents.ownership;
    }
    if (compareReleaseVersions(baselineVersion ?? "", "2026.7.2-beta.4") === -1) {
      agents.list = Object.entries<Record<string, unknown>>(agents.entries).map(([id, entry]) =>
        Object.assign(entry, { id }),
      );
      delete agents.entries;
    }
    return {
      ...step,
      argv: [...step.argv.slice(0, 3), JSON.stringify(agents), ...step.argv.slice(4)],
    };
  }
  if (
    step.id === "channels-discord" &&
    compareReleaseVersions(baselineVersion ?? "", "2026.7.2-beta.4") === -1
  ) {
    const discordJson = step.argv[3];
    if (discordJson === undefined) {
      throw new Error(`config recipe step ${step.id} is missing its JSON value`);
    }
    // beta.4 retired nested DM policy. Older baselines retain the shipped
    // specimen so candidate Doctor must migrate it without changing access.
    const { dmPolicy, allowFrom, ...discord } = JSON.parse(discordJson);
    discord.dm = { policy: dmPolicy, allowFrom };
    return {
      ...step,
      argv: [...step.argv.slice(0, 3), JSON.stringify(discord), ...step.argv.slice(4)],
    };
  }
  return step;
}

function* adaptRecipeForBaseline(
  steps: ConfigStep[],
  baselineVersion: string | null,
  scenario: string,
): Generator<ConfigStep> {
  // Older and suffixed releases retain their existing command and receipt contract.
  const pinnedVersion = parsePinnedReleaseVersion(baselineVersion ?? "");
  const comparison = pinnedVersion ? compareReleaseVersions(pinnedVersion, "2026.6.34") : null;
  const batchChannels = comparison !== null && comparison >= 0;
  let batchedThrough = -1;
  for (const [index, step] of steps.entries()) {
    if (index <= batchedThrough) {
      continue;
    }
    if (scenario === "base" && pinnedVersion === "2026.9.7" && step.id === "validate") {
      yield {
        id: "silent-reply-internal-retirement",
        intent: "silent-reply-internal-retirement",
        argv: [
          "config",
          "set",
          "--batch-json",
          JSON.stringify([
            {
              path: "agents.defaults.silentReply",
              value: { group: "allow", internal: "allow" },
            },
            {
              path: "surfaces.discord.silentReply",
              value: { group: "disallow", internal: "disallow" },
            },
          ]),
        ],
      };
    }
    if (
      batchChannels &&
      step.id === "channels-discord" &&
      steps[index + 1]?.id === "channels-telegram" &&
      steps[index + 2]?.id === "channels-whatsapp"
    ) {
      const channels = steps.slice(index, index + 3).map((channel) => {
        const adapted = adaptStepForBaseline(channel, baselineVersion);
        if (adapted.argv[3] === undefined) {
          throw new Error(`config recipe step ${channel.id} is missing its JSON value`);
        }
        return {
          intent: adapted.intent,
          path: adapted.argv[2],
          value: JSON.parse(adapted.argv[3]),
        };
      });
      yield {
        id: "channels",
        intent: "channels",
        intents: channels.map((channel) => channel.intent),
        argv: [
          "config",
          "set",
          "--batch-json",
          JSON.stringify(channels.map((channel) => ({ path: channel.path, value: channel.value }))),
        ],
      };
      batchedThrough = index + 2;
      continue;
    }
    yield adaptStepForBaseline(step, baselineVersion);
  }
}

export function resolveUpgradeSurvivorConfigStepsForBaseline(
  scenario = "base",
  baselineVersion: string | null = null,
): ConfigStep[] {
  return [
    ...adaptRecipeForBaseline(
      resolveUpgradeSurvivorConfigSteps(scenario),
      baselineVersion,
      scenario,
    ),
  ];
}

export function resolveUpgradeSurvivorOpenClawCommand(
  argv: string[],
  params: UpgradeSurvivorCommandParams = {},
) {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    const comSpec = params.comSpec ?? resolveWindowsCmdExePath(params.env ?? process.env);
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("openclaw.cmd", argv)],
      commandLabel: ["openclaw", ...argv].join(" "),
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: "openclaw",
    args: argv,
    commandLabel: ["openclaw", ...argv].join(" "),
    shell: false,
  };
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

export function runUpgradeSurvivorOpenClawStep(step: ConfigStep, params: ConfigCommandParams = {}) {
  const invocation = resolveUpgradeSurvivorOpenClawCommand(step.argv);
  const run: SpawnSyncCommand = params.spawnSyncCommand ?? spawnSync;
  const timeoutMs = params.timeoutMs ?? CONFIG_COMMAND_TIMEOUT_MS;
  const maxBuffer = params.maxBufferBytes ?? CONFIG_COMMAND_MAX_BUFFER_BYTES;
  const result = run(invocation.command, invocation.args, {
    encoding: "utf8",
    env: process.env,
    killSignal: "SIGTERM",
    maxBuffer,
    shell: invocation.shell,
    timeout: timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const code = errorCode(result.error);
  return {
    id: step.id,
    intent: step.intent,
    intents: step.intents,
    command: invocation.commandLabel,
    status: result.status,
    signal: result.signal,
    ok: result.status === 0 && !result.error,
    errorCode: code,
    errorMessage: result.error?.message ? tail(result.error.message) : undefined,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}

function applyRecipe() {
  const summaryPath = option("--summary");
  const baselineVersion = option("--baseline-version", null);
  const scenario = process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO || "base";
  const recipeSteps = resolveUpgradeSurvivorConfigSteps(scenario);
  const summary: {
    source: string;
    recipe: string;
    baselineVersion: string | null;
    scenario: string;
    acceptedIntents: string[];
    steps: ReturnType<typeof runUpgradeSurvivorOpenClawStep>[];
  } = {
    source: "baseline-cli-command-recipe",
    recipe: "upgrade-survivor-v1",
    baselineVersion,
    scenario,
    acceptedIntents: [],
    steps: [],
  };

  for (const step of adaptRecipeForBaseline(recipeSteps, baselineVersion, scenario)) {
    const outcome = runUpgradeSurvivorOpenClawStep(step);
    summary.steps.push(outcome);
    if (outcome.ok) {
      for (const intent of step.intents ?? [step.intent]) {
        if (!summary.acceptedIntents.includes(intent)) {
          summary.acceptedIntents.push(intent);
        }
      }
    }
    writeJson(summaryPath, summary);
    if (!outcome.ok) {
      const detail = outcome.errorCode ?? outcome.signal ?? outcome.status ?? "unknown";
      throw new Error(`baseline config recipe failed at ${step.id}: ${detail}`);
    }
  }
}

function main() {
  if (command === "apply") {
    applyRecipe();
  } else {
    throw new Error(`unknown upgrade-survivor config-recipe command: ${command ?? "<missing>"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
