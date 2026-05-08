import { spawn, type ChildProcess } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import { resolveExecutablePath } from "./local-cli.js";

type SpawnImpl = typeof spawn;

export type AgentkitRegisterPlan = {
  command: string;
  args: string[];
  walletAddress: string;
  cliCommand: string;
  cliArgs: string[];
  resolvedPath: string;
};

function resolveWalletAddress(params: {
  appConfig: OpenClawConfig;
  walletAddressOverride?: string;
}): string {
  const override = normalizeOptionalString(params.walletAddressOverride);
  if (override) {
    return override;
  }
  const configured = resolveConfiguredAgentkitPluginConfig(params.appConfig).walletAddress;
  if (configured) {
    return configured;
  }
  throw new Error(
    "AgentKit wallet address is not configured. Set `plugins.entries.agentkit.config.walletAddress` or pass `--wallet <address>`.",
  );
}

export async function resolveAgentkitRegisterPlan(params: {
  appConfig: OpenClawConfig;
  walletAddressOverride?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentkitRegisterPlan> {
  const pluginConfig = resolveConfiguredAgentkitPluginConfig(params.appConfig);
  const walletAddress = resolveWalletAddress(params);
  const resolvedPath = await resolveExecutablePath({
    command: pluginConfig.cli.command,
    env: params.env,
  });
  if (!resolvedPath) {
    throw new Error(
      `AgentKit CLI command \`${pluginConfig.cli.command}\` was not found on PATH. Install the CLI or update \`plugins.entries.agentkit.config.cli.command\`.`,
    );
  }
  return {
    command: resolvedPath,
    args: [...pluginConfig.cli.args, "register", walletAddress],
    walletAddress,
    cliCommand: pluginConfig.cli.command,
    cliArgs: pluginConfig.cli.args,
    resolvedPath,
  };
}

export function formatAgentkitRegisterPlanText(plan: AgentkitRegisterPlan): string {
  return [
    "AgentKit registration plan:",
    `- wallet address: ${plan.walletAddress}`,
    `- configured CLI command: ${plan.cliCommand}`,
    `- configured CLI args: ${plan.cliArgs.length > 0 ? plan.cliArgs.join(" ") : "(none)"}`,
    `- resolved executable: ${plan.resolvedPath}`,
    `- invocation: ${[plan.command, ...plan.args].join(" ")}`,
  ].join("\n");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`AgentKit CLI exited with code ${code ?? "unknown"}.`));
    });
  });
}

export async function runAgentkitRegister(params: {
  plan: AgentkitRegisterPlan;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnImpl;
}): Promise<void> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const child = spawnImpl(params.plan.command, params.plan.args, {
    stdio: "inherit",
    env: params.env ?? process.env,
    shell: process.platform === "win32",
  });
  await waitForExit(child);
}
