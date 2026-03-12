import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(rootDir, "scripts", "bundle-a2ui.sh");

function resolveWindowsBash() {
  const candidates = [
    process.env.OPENCLAW_GIT_BASH,
    process.env.GIT_BASH_PATH,
    process.env.ProgramW6432 && path.join(process.env.ProgramW6432, "Git", "bin", "bash.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Git", "usr", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "bash.exe"),
  ].filter((value) => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const shell = process.platform === "win32" ? (resolveWindowsBash() ?? "bash") : "bash";

const result = spawnSync(shell, [scriptPath], {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  if (process.platform === "win32") {
    console.error(
      "A2UI bundling requires Git Bash on Windows. Set OPENCLAW_GIT_BASH to bash.exe if Git is installed in a non-standard location.",
    );
  }
  throw result.error;
}

process.exit(result.status ?? 1);
