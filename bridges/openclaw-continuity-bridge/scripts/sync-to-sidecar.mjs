import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecarRoot = join(homedir(), ".airya", "mcp");

const files = [
  "run-continuity-bridge.sh",
  "openclaw-continuity-bridge.ts",
  "engine-tools.ts",
  "proxy.ts",
  "memory-read-tools.ts",
  "workspace-context.ts",
  "__tests__/engine-tools.test.ts",
  "__tests__/proxy.test.ts",
  "__tests__/openclaw-continuity-bridge.test.ts",
];

for (const relativePath of files) {
  const sourcePath = join(packageRoot, relativePath);
  const destinationPath = join(sidecarRoot, relativePath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  if (relativePath === "run-continuity-bridge.sh") {
    chmodSync(destinationPath, 0o755);
  }
}

process.stdout.write(
  `Synced ${files.length} tracked bridge files from ${packageRoot} to ${sidecarRoot}\n`,
);
