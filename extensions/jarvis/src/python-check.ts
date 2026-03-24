import { spawn } from "node:child_process";

const MIN_PYTHON_VERSION = "3.10";

export type PythonCheckResult =
  | { ok: true; pythonCommand: string; pythonVersion: string }
  | {
      ok: false;
      reason: "missing-command" | "version-too-low" | "probe-failed";
      message: string;
      setupInstructions: string;
    };

export function parsePythonVersion(stdout: string): string | null {
  const match = stdout.match(/Python\s+(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export function meetsMinVersion(version: string, min: string): boolean {
  const [aMajor, aMinor] = version.split(".").map(Number);
  const [bMajor, bMinor] = min.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor > bMajor;
  return aMinor >= bMinor;
}

export async function checkPythonEnvironment(opts: {
  pythonCommand?: string;
}): Promise<PythonCheckResult> {
  const cmd = opts.pythonCommand ?? "python3";
  const setupInstructions = [
    "Jarvis requires Python 3.10+. To set up:",
    "  1. Install Python 3.10+: https://www.python.org/downloads/",
    `  2. Verify: ${cmd} --version`,
    "  3. Install Jarvis deps: pip install fastmcp pydantic numpy",
  ].join("\n");

  let stdout: string;
  try {
    stdout = await spawnCollect(cmd, ["--version"]);
  } catch {
    return {
      ok: false,
      reason: "missing-command",
      message: `Python command '${cmd}' not found.`,
      setupInstructions,
    };
  }

  const version = parsePythonVersion(stdout);
  if (!version) {
    return {
      ok: false,
      reason: "probe-failed",
      message: `Could not parse Python version from: ${stdout.trim()}`,
      setupInstructions,
    };
  }

  if (!meetsMinVersion(version, MIN_PYTHON_VERSION)) {
    return {
      ok: false,
      reason: "version-too-low",
      message: `Python ${version} found, but ${MIN_PYTHON_VERSION}+ is required.`,
      setupInstructions,
    };
  }

  return { ok: true, pythonCommand: cmd, pythonVersion: version };
}

function spawnCollect(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });
    let stdout = "";
    // Collect both stdout and stderr since `python --version` may write to either
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}
