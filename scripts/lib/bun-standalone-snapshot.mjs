import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const STANDALONE_RUNTIME_ROOTS = [
  "dist",
  "node_modules",
  "packages",
  "extensions",
  "skills",
  "custodian-skills",
];

// Preserve pnpm workspace links while taking a fresh, checkout-independent snapshot.
export function copyStandaloneRuntime(sourceRoot, runtimeRoot) {
  fs.mkdirSync(runtimeRoot);
  const entries = [
    ...STANDALONE_RUNTIME_ROOTS,
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ];
  entries.push(...fs.readdirSync(sourceRoot).filter((name) => name.endsWith(".mjs")));
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry);
    const destination = path.join(runtimeRoot, entry);
    if (process.platform === "darwin") {
      const copy = spawnSync("/bin/cp", ["-cR", source, destination], { stdio: "inherit" });
      if (copy.status !== 0) {
        throw new Error(`Could not clone ${source}`);
      }
    } else {
      fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    }
  }
  fs.mkdirSync(path.join(runtimeRoot, "docs/reference"), { recursive: true });
  fs.cpSync(
    path.join(sourceRoot, "docs/reference/templates"),
    path.join(runtimeRoot, "docs/reference/templates"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(runtimeRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, "scripts/windows-cmd-helpers.mjs"),
    path.join(runtimeRoot, "scripts/windows-cmd-helpers.mjs"),
  );
}
