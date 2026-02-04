import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

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
