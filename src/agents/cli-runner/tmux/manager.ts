import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import type {
  NormalizedTmuxConfig,
  TmuxCommandRunner,
  TmuxEnsureSessionResult,
  TmuxMetadata,
  TmuxRuntimePaths,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const defaultTmuxCommandRunner: TmuxCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function writeLauncher(params: {
  file: string;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
}): Promise<void> {
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const command = ${JSON.stringify(params.command)};
const args = ${JSON.stringify(params.args)};
const cwd = ${JSON.stringify(params.cwd)};
const envKeys = ${JSON.stringify(params.envKeys)};
const env = {};
for (const key of envKeys) {
  if (process.env[key] !== undefined) {
    env[key] = process.env[key];
  }
}

const child = spawn(command, args, {
  cwd,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(127);
});
`;
  await fs.writeFile(params.file, script, { mode: 0o700 });
  await fs.chmod(params.file, 0o700);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function metadataMatches(existing: TmuxMetadata | null, expected: TmuxMetadata): boolean {
  if (!existing) {
    return false;
  }
  return (
    existing.backendId === expected.backendId &&
    existing.workspaceDir === expected.workspaceDir &&
    existing.sessionName === expected.sessionName &&
    existing.launchHash === expected.launchHash &&
    existing.model === expected.model &&
    existing.systemPromptHash === expected.systemPromptHash &&
    (existing.mcpConfigHash ?? "") === (expected.mcpConfigHash ?? "") &&
    (existing.authProfileId ?? "") === (expected.authProfileId ?? "") &&
    existing.memoryMode === expected.memoryMode &&
    existing.hookMode === expected.hookMode
  );
}

export class TmuxSessionManager {
  constructor(private readonly runCommand: TmuxCommandRunner = defaultTmuxCommandRunner) {}

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await this.runCommand("tmux", ["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await this.runCommand("tmux", ["kill-session", "-t", sessionName]);
    } catch {
      // Session cleanup is best-effort; callers can recreate on the next run.
    }
  }

  async ensureSession(params: {
    paths: TmuxRuntimePaths;
    metadata: TmuxMetadata;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    config: NormalizedTmuxConfig;
  }): Promise<TmuxEnsureSessionResult> {
    const exists = await this.hasSession(params.metadata.sessionName);
    const existingMetadata = await readJsonFile<TmuxMetadata>(params.paths.metadataFile);
    if (exists && metadataMatches(existingMetadata, params.metadata)) {
      await fs.writeFile(
        params.paths.metadataFile,
        `${JSON.stringify({ ...existingMetadata, lastUsedAt: Date.now() }, null, 2)}\n`,
      );
      return { created: false };
    }
    if (exists) {
      await this.killSession(params.metadata.sessionName);
    }
    const envEntries = Object.entries(params.env).filter(
      (entry): entry is [string, string] =>
        ENV_KEY_RE.test(entry[0]) && typeof entry[1] === "string" && !entry[1].includes("\0"),
    );
    const envKeys = envEntries.map(([key]) => key);
    await fs.writeFile(params.paths.paneLogFile, "", { mode: 0o600 });
    await fs.writeFile(params.paths.eventsFile, "", { mode: 0o600 });
    await writeLauncher({
      file: params.paths.launcherFile,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      envKeys,
    });
    await this.runCommand(
      "tmux",
      [
        "new-session",
        "-d",
        ...envEntries.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "-s",
        params.metadata.sessionName,
        "-c",
        params.cwd,
        "--",
        "node",
        params.paths.launcherFile,
      ],
      { cwd: params.cwd },
    );
    await this.runCommand("tmux", [
      "pipe-pane",
      "-o",
      "-t",
      `${params.metadata.sessionName}:0.0`,
      `cat >> ${shellQuote(params.paths.paneLogFile)}`,
    ]);
    await fs.writeFile(params.paths.metadataFile, `${JSON.stringify(params.metadata, null, 2)}\n`, {
      mode: 0o600,
    });
    return { created: true };
  }

  async pastePrompt(params: {
    sessionName: string;
    bufferName: string;
    promptFile: string;
  }): Promise<void> {
    await this.runCommand("tmux", ["load-buffer", "-b", params.bufferName, params.promptFile]);
    await this.runCommand("tmux", [
      "paste-buffer",
      "-b",
      params.bufferName,
      "-t",
      `${params.sessionName}:0.0`,
    ]);
    await this.runCommand("tmux", ["send-keys", "-t", `${params.sessionName}:0.0`, "Enter"]);
  }

  async sendEnter(sessionName: string): Promise<void> {
    await this.runCommand("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "Enter"]);
  }

  async captureTail(sessionName: string, lines: number): Promise<string> {
    try {
      const result = await this.runCommand("tmux", [
        "capture-pane",
        "-p",
        "-J",
        "-S",
        `-${Math.max(1, lines)}`,
        "-t",
        `${sessionName}:0.0`,
      ]);
      return result.stdout;
    } catch {
      return "";
    }
  }

  async interrupt(sessionName: string): Promise<void> {
    try {
      await this.runCommand("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "C-c"]);
    } catch {
      await this.killSession(sessionName);
    }
  }
}
