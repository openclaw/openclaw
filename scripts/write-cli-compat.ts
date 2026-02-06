import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

// Check if daemon-cli has its own entry point output (new tsdown config)
const directOutput = path.join(cliDir, "daemon-cli.js");
if (fs.existsSync(directOutput)) {
  console.log(
    "[write-cli-compat] daemon-cli.js already exists as entry point output, no shim needed",
  );
  process.exit(0);
}

// Fall back to barrel file lookup (legacy behavior)
const candidates = fs
  .readdirSync(distDir)
  .filter((entry) => entry.startsWith("daemon-cli-") && entry.endsWith(".js"));

if (candidates.length === 0) {
  throw new Error("No daemon-cli bundle found in dist; cannot write legacy CLI shim.");
}

const target = candidates.toSorted()[0];
const relPath = `../${target}`;

const contents =
  "// Legacy shim for pre-tsdown update-cli imports.\n" +
  `export { registerDaemonCli, runDaemonInstall, runDaemonRestart, runDaemonStart, runDaemonStatus, runDaemonStop, runDaemonUninstall } from "${relPath}";\n`;

fs.mkdirSync(cliDir, { recursive: true });
fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
