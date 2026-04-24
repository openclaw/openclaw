import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  return spawn(
    options.command,
    options.args,
    buildCodexAppServerStdioSpawnOptions(options, process.platform),
  );
}

export function buildCodexAppServerStdioSpawnOptions(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv">,
  platform: NodeJS.Platform,
): SpawnOptionsWithoutStdio {
  const env = {
    ...process.env,
    ...options.env,
  };
  for (const key of options.clearEnv ?? []) {
    delete env[key];
  }

  return {
    env,
    detached: platform !== "win32",
    shell: platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  };
}
