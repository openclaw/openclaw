#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { format } from "oxfmt";
import {
  compareStableReleases,
  isStableRelease,
  parsePluginSdkShippedSurface,
  shippedSurfacePath,
  typedPluginSdkSubpaths,
} from "./lib/plugin-sdk-shipped-surface.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { renderPluginSdkApiRevisions } from "./plugin-sdk-api-diff.mts";

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const release = args[1];
  if (args.length !== 2 || args[0] !== "--release" || !release) {
    throw new Error("Usage: pnpm plugin-sdk:shipped-surface:gen -- --release <stable tag>");
  }
  if (!isStableRelease(release)) {
    throw new Error(`Expected a stable release tag (vX.Y.Z), got ${release}`);
  }
  const repoRoot = resolveRepoRoot(import.meta.url);
  const git = (gitArgs: string[]) =>
    execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).trim();
  const output = path.join(repoRoot, shippedSurfacePath);
  let existing: string | undefined;
  try {
    existing = await fs.readFile(output, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const committed = git(["ls-tree", "HEAD", "--", shippedSurfacePath])
    ? git(["show", `HEAD:${shippedSurfacePath}`])
    : undefined;
  for (const content of [committed, existing]) {
    if (content === undefined) {
      continue;
    }
    const inventory = parsePluginSdkShippedSurface(JSON.parse(content));
    if (compareStableReleases(release, inventory.release) < 0) {
      throw new Error(`Refusing to replace ${inventory.release} with older release ${release}`);
    }
  }
  const commit = git(["rev-parse", "--verify", `refs/tags/${release}^{commit}`]);
  const subpaths = typedPluginSdkSubpaths(JSON.parse(git(["show", `${commit}:package.json`])));
  const rendered = (await renderPluginSdkApiRevisions(repoRoot, [commit])).get(commit);
  if (!rendered) {
    throw new Error(`No rendered Plugin SDK surface for ${release}`);
  }
  const modules = new Map(rendered.modules.map((module) => [module.entrypoint, module]));
  const entrypoints = Object.fromEntries(
    subpaths.map((subpath) => {
      const module = modules.get(subpath);
      if (!module) {
        throw new Error(`Typed package subpath ${subpath} in ${release} has no rendered module`);
      }
      return [
        subpath,
        module.exports
          .map((entry) => entry.exportName)
          .filter((name) => name !== "default")
          .toSorted(),
      ];
    }),
  );
  const inventory = parsePluginSdkShippedSurface({
    commit,
    entrypoints,
    release,
    schema: "openclaw.plugin-sdk-shipped-surface/v1",
  });
  const result = await format(
    shippedSurfacePath,
    JSON.stringify({
      commit: inventory.commit,
      entrypoints: inventory.entrypoints,
      release: inventory.release,
      schema: inventory.schema,
    }),
  );
  if (result.errors.length) {
    throw new Error(`Could not format ${shippedSurfacePath}: ${JSON.stringify(result.errors)}`);
  }
  await fs.writeFile(output, result.code);
  console.log(
    `Generated ${shippedSurfacePath} from ${release} (${commit}): ${subpaths.length} typed subpaths, ${Object.values(entrypoints).reduce((count, names) => count + names.length, 0)} named exports.`,
  );
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode ||= 1;
});
