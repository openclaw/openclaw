import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

export type CliBackendReadinessStatus = "ready" | "backend_config_error" | "command_unresolvable";

export type CliBackendReadiness = {
  provider: string;
  backendId: string;
  command: string;
  resolvedPath?: string;
  status: CliBackendReadinessStatus;
  detail: string;
  hint?: string;
};

function resolveCommandPath(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return fs.existsSync(trimmed) ? trimmed : undefined;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [trimmed], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return undefined;
  }

  const match = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return match;
}

function isLikelyCommandWithArgs(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  return /\s/u.test(trimmed) && !fs.existsSync(trimmed);
}

function defaultMissingConfig(provider: string): CliBackendReadiness {
  return {
    provider,
    backendId: provider,
    command: "",
    status: "backend_config_error",
    detail: `CLI backend "${provider}" is missing or invalid.`,
    hint: `Set agents.defaults.cliBackends["${provider}"].command to an installed executable (for example: "claude").`,
  };
}

export function resolveCliBackendReadiness(params: {
  provider: string;
  cfg: OpenClawConfig;
}): CliBackendReadiness {
  const provider = params.provider.trim();
  const backend = resolveCliBackendConfig(provider, params.cfg);
  if (!backend) {
    return defaultMissingConfig(provider);
  }

  const command = backend.config.command.trim();
  if (!command) {
    return {
      provider,
      backendId: backend.id,
      command,
      status: "backend_config_error",
      detail: `CLI backend "${backend.id}" command is empty.`,
      hint: `Set agents.defaults.cliBackends["${backend.id}"].command to an installed executable.`,
    };
  }

  if (isLikelyCommandWithArgs(command)) {
    return {
      provider,
      backendId: backend.id,
      command,
      status: "backend_config_error",
      detail: `CLI backend "${backend.id}" command looks like command + flags: ${command}`,
      hint: `Set only the executable in agents.defaults.cliBackends["${backend.id}"].command and move flags to agents.defaults.cliBackends["${backend.id}"].args.`,
    };
  }

  const resolvedPath = resolveCommandPath(command);
  if (!resolvedPath) {
    return {
      provider,
      backendId: backend.id,
      command,
      status: "command_unresolvable",
      detail: `CLI backend command not found: ${command}`,
      hint: `Install the CLI or set an absolute command path in agents.defaults.cliBackends["${backend.id}"].command.`,
    };
  }

  return {
    provider,
    backendId: backend.id,
    command,
    resolvedPath,
    status: "ready",
    detail: `CLI backend command resolved: ${resolvedPath}`,
  };
}

export function resolveCliProvidersReadiness(params: {
  providers: string[];
  cfg: OpenClawConfig;
}): CliBackendReadiness[] {
  const uniqueProviders = Array.from(
    new Set(params.providers.map((provider) => provider.trim()).filter(Boolean)),
  ).toSorted((a, b) => a.localeCompare(b));

  return uniqueProviders.map((provider) =>
    resolveCliBackendReadiness({
      provider,
      cfg: params.cfg,
    }),
  );
}
