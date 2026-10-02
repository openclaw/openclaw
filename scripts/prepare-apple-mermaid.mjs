#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = path.join(root, "apps/shared/mermaid/assets");
const receipt = path.join(assets, "apple-build-inputs.json");

async function hashFiles(paths, base = root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const absolute = path.join(base, relative);
    if ((await stat(absolute)).isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (!["node_modules", "dist"].includes(entry.name)) {
          await visit(path.join(relative, entry.name));
        }
      }
    } else {
      hash
        .update(relative)
        .update("\0")
        .update(await readFile(absolute))
        .update("\0");
    }
  }
  for (const relative of paths) {
    await visit(relative);
  }
  return hash.digest("hex");
}

const inputs = await hashFiles([
  "packages/mermaid-renderer",
  "packages/normalization-core",
  "scripts/prepare-apple-mermaid.mjs",
  "scripts/pnpm-runner.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/run-node-package-bin.mts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
]);
const key = `${process.platform}-${process.arch}-${process.version}-${inputs}`;
if (process.argv.includes("--cache-key")) {
  console.log(key);
  process.exit(0);
}

// Restores are hints: missing, stale or damaged assets take the ordinary build path.
const cached = await readFile(receipt, "utf8")
  .then(JSON.parse)
  .catch(() => null);
const outputHash = await hashFiles(["mermaid"], assets).catch(() => null);
if (cached?.key === key && outputHash && cached.outputHash === outputHash) {
  console.log("Apple Mermaid assets: verified cache hit");
} else {
  const spec = createPnpmRunnerSpawnSpec({
    cwd: root,
    pnpmArgs: ["--dir", "packages/mermaid-renderer", "build"],
    stdio: "inherit",
  });
  const result = spawnSync(spec.command, spec.args, spec.options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  await writeFile(
    receipt,
    JSON.stringify({ key, outputHash: await hashFiles(["mermaid"], assets) }),
  );
}

const source = new URL("../apps/shared/mermaid/assets/mermaid/", import.meta.url);
const resources = new URL(
  "../apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/",
  import.meta.url,
);
const destination = new URL("Mermaid/", resources);
await mkdir(resources, { recursive: true });
// SwiftPM needs the complete resource directory before project generation.
// Replace generated assets together so old content-addressed scripts cannot linger.
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
