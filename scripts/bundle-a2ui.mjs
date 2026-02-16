#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === "win32";

const scriptPath = isWindows
  ? path.join(__dirname, "bundle-a2ui.ps1")
  : path.join(__dirname, "bundle-a2ui.sh");

const cmdArgs = isWindows
  ? ["powershell", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
  : ["bash", scriptPath];

const result = spawnSync(cmdArgs[0], cmdArgs.slice(1), {
  stdio: "inherit",
  shell: isWindows,
});

process.exit(result.status ?? 1);
