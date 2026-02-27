import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

export type CliBackendAvailability = {
  id: "claude-cli" | "codex-cli";
  binaryName: string;
  binaryFound: boolean;
  binaryPath?: string;
  credentialsFound: boolean;
  credentialsPath: string;
  configDirExists: boolean;
  configDirPath: string;
};

function resolveClaudeConfigDir(): string {
  return resolveUserPath("~/.claude");
}

function resolveClaudeCredentialsPath(): string {
  return path.join(resolveClaudeConfigDir(), ".credentials.json");
}

function resolveCodexConfigDir(): string {
  const configured = process.env.CODEX_HOME;
  if (configured) {
    return resolveUserPath(configured);
  }
  return resolveUserPath("~/.codex");
}

function resolveCodexCredentialsPath(): string {
  return path.join(resolveCodexConfigDir(), "auth.json");
}

function whichBinary(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFile(cmd, [name], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(undefined);
        return;
      }
      resolve(stdout.trim().split("\n")[0]?.trim());
    });
  });
}

export async function checkCliBackendAvailability(
  backendId: "claude-cli" | "codex-cli",
): Promise<CliBackendAvailability> {
  if (backendId === "claude-cli") {
    const binaryName = "claude";
    const configDirPath = resolveClaudeConfigDir();
    const credentialsPath = resolveClaudeCredentialsPath();
    const binaryPath = await whichBinary(binaryName);
    return {
      id: backendId,
      binaryName,
      binaryFound: Boolean(binaryPath),
      binaryPath,
      credentialsFound: fs.existsSync(credentialsPath),
      credentialsPath,
      configDirExists: fs.existsSync(configDirPath),
      configDirPath,
    };
  }

  const binaryName = "codex";
  const configDirPath = resolveCodexConfigDir();
  const credentialsPath = resolveCodexCredentialsPath();
  const binaryPath = await whichBinary(binaryName);
  return {
    id: backendId,
    binaryName,
    binaryFound: Boolean(binaryPath),
    binaryPath,
    credentialsFound: fs.existsSync(credentialsPath),
    credentialsPath,
    configDirExists: fs.existsSync(configDirPath),
    configDirPath,
  };
}

/** Format a human-readable status summary for a CLI backend availability check. */
export function formatCliBackendStatus(availability: CliBackendAvailability): string {
  const lines: string[] = [];
  if (availability.binaryFound) {
    lines.push(`Binary: ${availability.binaryName} (${availability.binaryPath})`);
  } else {
    lines.push(`Binary: ${availability.binaryName} not found in PATH`);
  }
  if (availability.credentialsFound) {
    lines.push(`Credentials: ${availability.credentialsPath}`);
  } else {
    lines.push(`Credentials: not found (${availability.credentialsPath})`);
  }
  return lines.join("\n");
}
