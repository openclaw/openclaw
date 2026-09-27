import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import type { ResolvedMemoryWikiConfig } from "./config.js";

type ObsidianCliProbe = {
  available: boolean;
  command: string | null;
};

type ObsidianCliResult = {
  command: string;
  argv: string[];
  stdout: string;
  stderr: string;
};

// User-triggered CLI helpers must not pin the gateway when Obsidian stops responding.
const OBSIDIAN_CLI_TIMEOUT_MS = 10_000;

type ObsidianCliDeps = {
  exec?: (
    command: string,
    args: string[],
    options: { logOutput: false; timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  resolveCommand?: (command: string) => Promise<string | null>;
};

async function isExecutableFile(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    // X_OK also succeeds for searchable directories; follow symlinks to check the target type.
    return (await fs.stat(inputPath)).isFile();
  } catch {
    return false;
  }
}

async function resolveCommandOnPath(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const windowsExts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"])
      : [""];

  for (const dir of pathEntries) {
    for (const extension of windowsExts) {
      const candidate = path.join(dir, extension ? `${command}${extension}` : command);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export async function probeObsidianCli(
  deps?: Pick<ObsidianCliDeps, "resolveCommand">,
): Promise<ObsidianCliProbe> {
  const resolveCommand = deps?.resolveCommand ?? resolveCommandOnPath;
  const command = await resolveCommand("obsidian");
  return {
    available: command !== null,
    command,
  };
}

export const OBSIDIAN_ACTIONS = [
  {
    command: "search",
    description: "Search the current Obsidian vault",
    argument: { name: "query", description: "Search query" },
    success: "",
  },
  {
    command: "open",
    description: "Open a file in Obsidian by vault-relative path",
    argument: { name: "path", description: "Vault-relative path" },
    success: "Opened in Obsidian.",
  },
  {
    command: "command",
    description: "Execute an Obsidian command palette command by id",
    argument: { name: "id", description: "Obsidian command id" },
    success: "Command sent to Obsidian.",
  },
  {
    command: "daily",
    description: "Open today's daily note in Obsidian",
    argument: undefined,
    success: "Opened today's daily note.",
  },
] as const;

export function assertOfficialObsidianCliSupported(config: ResolvedMemoryWikiConfig): void {
  if (config.vault.scope === "agent") {
    throw new Error("Official Obsidian CLI actions do not support memory-wiki vault.scope=agent.");
  }
}

export async function runObsidianAction(params: {
  config: ResolvedMemoryWikiConfig;
  action: (typeof OBSIDIAN_ACTIONS)[number];
  value?: string;
  deps?: ObsidianCliDeps;
}): Promise<ObsidianCliResult> {
  const probe = await probeObsidianCli(params.deps);
  if (!probe.command) {
    throw new Error("Obsidian CLI is not available on PATH.");
  }
  const { vaultName } = params.config.obsidian;
  const argv = [
    ...(vaultName ? [`vault=${vaultName}`] : []),
    params.action.command,
    ...(params.action.argument ? [`${params.action.argument.name}=${params.value}`] : []),
  ];
  const exec = params.deps?.exec ?? runExec;
  const { stdout, stderr } = await exec(probe.command, argv, {
    logOutput: false,
    timeoutMs: OBSIDIAN_CLI_TIMEOUT_MS,
  });
  return {
    command: probe.command,
    argv,
    stdout,
    stderr,
  };
}
