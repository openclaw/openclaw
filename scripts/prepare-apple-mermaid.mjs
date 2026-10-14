#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePnpmLockfileSections,
  pnpmLockfileDocuments,
  resolveSnapshot,
} from "./lib/pnpm-lockfile-documents.mjs";
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

// An unrelated workspace dependency must not evict the native renderer. Keep
// resolved peers, optional dependencies and integrity metadata for its full graph.
const documents = pnpmLockfileDocuments(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
const { importerRoots, importerMetadata, packageBlocks, snapshots, snapshotBlocks, globalBlocks } =
  parsePnpmLockfileSections(documents.dependencies);
const selectedImporters = {};
const selectedPackages = {};
const selectedSnapshots = {};
function visitPackage(name, reference) {
  const resolved = resolveSnapshot({
    dependencyName: name,
    reference,
    snapshots,
    includeLocal: true,
  });
  const { snapshotKey, packageName, version } = resolved;
  if (snapshotKey in selectedSnapshots) {
    return;
  }
  const snapshot = snapshots[snapshotKey];
  selectedSnapshots[snapshotKey] = snapshotBlocks.get(snapshotKey).source;
  const packageKey = `${packageName}@${version}`;
  if (!packageBlocks.has(packageKey)) {
    throw new Error(`Missing Mermaid build dependency metadata: ${packageKey}`);
  }
  selectedPackages[packageKey] = packageBlocks.get(packageKey).source;
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [dependency, dependencyReference] of Object.entries(snapshot[field] ?? {})) {
      visitPackage(dependency, dependencyReference);
    }
  }
}
function visitWorkspace(directory) {
  if (directory in selectedImporters) {
    return;
  }
  const importer = importerRoots.get(directory);
  if (!importer) {
    throw new Error(`Missing Mermaid build workspace: ${directory}`);
  }
  selectedImporters[directory] = {
    groups: [...importer],
    metadata: importerMetadata.get(directory),
  };
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const { dependencyName, reference } of importer.get(field) ?? []) {
      if (reference.startsWith("link:")) {
        visitWorkspace(path.posix.normalize(path.posix.join(directory, reference.slice(5))));
      } else {
        visitPackage(dependencyName, reference);
      }
    }
  }
}
visitWorkspace("packages/mermaid-renderer");
const packageManager = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).packageManager;
const sourceHash = await hashFiles([
  ...Object.keys(selectedImporters).toSorted(),
  "scripts/prepare-apple-mermaid.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/pnpm-runner.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/run-node-package-bin.mts",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  "patches",
]);
const inputs = createHash("sha256")
  .update(sourceHash)
  .update(
    JSON.stringify({
      packageManager,
      environment: documents.environment,
      settings: [...globalBlocks].map(([name, block]) => [name, block.source]),
      importers: selectedImporters,
      packages: selectedPackages,
      snapshots: selectedSnapshots,
    }),
  )
  .digest("hex");
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
