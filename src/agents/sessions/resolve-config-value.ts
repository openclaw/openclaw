/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  buildShellCommandInvocation,
  getBashShellConfig,
  getBashShellEnv,
} from "../shell-utils.js";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export function resolveConfigValue(config: string): string | undefined {
  if (!config.startsWith("!")) {
    return resolveConfigValueUncached(config);
  }
  if (!commandResultCache.has(config)) {
    commandResultCache.set(config, executeCommandUncached(config));
  }
  return commandResultCache.get(config);
}

function executeWithConfiguredShell(command: string): {
  executed: boolean;
  value: string | undefined;
} {
  try {
    const shellConfig = getBashShellConfig();
    const invocation = buildShellCommandInvocation(command, shellConfig);
    const [shell, ...args] = invocation.argv;
    const result = spawnSync(shell, args, {
      encoding: "utf-8",
      ...(invocation.input === undefined ? {} : { input: invocation.input }),
      timeout: 10000,
      stdio: [invocation.stdin, "pipe", "ignore"],
      shell: false,
      windowsHide: true,
      env: getBashShellEnv(shellConfig.shell),
    });

    if (result.error || result.status !== 0) {
      const error = result.error as NodeJS.ErrnoException | undefined;
      return { executed: error?.code !== "ENOENT", value: undefined };
    }

    const value = (result.stdout ?? "").trim();
    return { executed: true, value: value || undefined };
  } catch {
    return { executed: false, value: undefined };
  }
}

function executeWithDefaultShell(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeCommandUncached(commandConfig: string): string | undefined {
  const command = commandConfig.slice(1);
  if (process.platform === "win32") {
    const configuredResult = executeWithConfiguredShell(command);
    if (configuredResult.executed) {
      return configuredResult.value;
    }
  }
  return executeWithDefaultShell(command);
}

export function resolveConfigValueUncached(config: string): string | undefined {
  if (config.startsWith("!")) {
    return executeCommandUncached(config);
  }
  if (Object.hasOwn(process.env, config)) {
    return process.env[config] || undefined;
  }
  return config;
}

export function resolveConfigValueOrThrow(config: string, description: string): string {
  const resolvedValue = resolveConfigValueUncached(config);
  if (resolvedValue !== undefined) {
    return resolvedValue;
  }

  if (config.startsWith("!")) {
    throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
  }

  throw new Error(`Failed to resolve ${description}`);
}

export function resolveHeadersOrThrow(
  headers: Record<string, string> | undefined,
  description: string,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
