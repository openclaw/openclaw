import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseTagPackageIdentity } from "./release-version.mjs";
import { collectRootPackageExcludedExtensionDirs } from "./root-package-bundled-plugin-excludes.mjs";

const MAX_PLUGIN_BYTES = 300 * 1024 * 1024;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function requireReleaseTagCommit(root, tag, commit, verifiedCommit) {
  let actual = verifiedCommit;
  if (actual === undefined) {
    const ref = `refs/tags/${tag}`;
    try {
      actual = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      git(root, ["fetch", "--no-tags", "origin", `${ref}:${ref}`]);
      actual = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    }
  }
  if (actual !== commit) {
    throw new Error(`Release tag ${tag} commit ${actual} does not match source commit ${commit}.`);
  }
}

/** Use the publication owner's tag/version identity, including same-source corrections. */
export function desktopRuntimeReleaseTag(root, version, commit) {
  // Release jobs check out a verified SHA without necessarily fetching tags.
  const releaseTag = process.env.RELEASE_TAG;
  const releaseSha = process.env.RELEASE_SHA;
  if (releaseTag !== undefined || releaseSha !== undefined) {
    if (!releaseTag) {
      throw new Error("Explicit desktop release identity requires RELEASE_TAG.");
    }
    const { baseTag } = resolveReleaseTagPackageIdentity(releaseTag, version);
    requireReleaseTagCommit(root, releaseTag, commit, releaseSha);
    if (baseTag) {
      requireReleaseTagCommit(root, baseTag, commit);
    }
    return releaseTag;
  }
  const tags = git(root, ["tag", "--points-at", commit]).split("\n").filter(Boolean);
  for (const tag of tags) {
    let identity;
    try {
      identity = resolveReleaseTagPackageIdentity(tag, version);
    } catch {
      continue;
    }
    if (identity.baseTag && !tags.includes(identity.baseTag)) {
      throw new Error(
        `Release tag ${tag} requires same-source base tag ${identity.baseTag}; fetch that tag and verify it points at ${commit} before packaging.`,
      );
    }
    return tag;
  }
  return null;
}

function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += directoryBytes(file);
    } else if (entry.isFile()) {
      bytes += fs.statSync(file).size;
    }
  }
  return bytes;
}

function dependencyRoot(from, name) {
  for (let cursor = from; ; cursor = path.dirname(cursor)) {
    const candidate = path.join(cursor, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
    if (cursor === path.dirname(cursor)) {
      return null;
    }
  }
}

function runtimeDependencies(root, seen = new Set()) {
  const manifest = readJson(path.join(root, "package.json"));
  for (const [name, optional] of [
    ...Object.keys(manifest.dependencies ?? {}).map((dependencyName) => [dependencyName, false]),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((dependencyName) => [
      dependencyName,
      true,
    ]),
  ]) {
    const dependency = dependencyRoot(root, name);
    if (!dependency) {
      if (optional) {
        continue;
      }
      throw new Error(
        `Missing build dependency ${name} from ${root}; install workspace dependencies first.`,
      );
    }
    if (seen.has(dependency)) {
      continue;
    }
    seen.add(dependency);
    runtimeDependencies(dependency, seen);
  }
  return seen;
}

// codex-voice-host serves only the Codex TUI's realtime voice (codex-rs/tui ->
// codex-realtime-webrtc -> VoiceHost); the app-server OpenClaw runs never starts
// it. Its published copies also carry LC_RPATHs into the Bazel build tree, so the
// staged runtime leaves the whole voice payload out instead of shipping it.
function removeStagedCodexVoiceHelper(packageRoot) {
  const codex = dependencyRoot(path.join(packageRoot, "dist/extensions/codex"), "@openai/codex");
  if (!codex) {
    return;
  }
  for (const [architecture, target] of [
    ["arm64", "aarch64-apple-darwin"],
    ["x64", "x86_64-apple-darwin"],
  ]) {
    const platform = dependencyRoot(codex, `@openai/codex-darwin-${architecture}`);
    if (platform) {
      fs.rmSync(path.join(platform, "vendor", target, "codex-resources/voice"), {
        recursive: true,
        force: true,
      });
    }
  }
}

/** Select all official source plugins unless their additional installed payload exceeds 300 MiB. */
export function planDesktopRuntimePlugins(root, { pluginIds: selectedIds } = {}) {
  const manifest = readJson(path.join(root, "package.json"));
  const commit = git(root, ["rev-parse", "HEAD"]);
  const releaseTag = desktopRuntimeReleaseTag(root, manifest.version, commit);
  if (releaseTag) {
    return { commit, releaseTag, pluginIds: [] };
  }
  const build = readJson(path.join(root, "dist", "build-info.json"));
  if (build.commit !== commit) {
    throw new Error(
      "Build the desktop runtime from the current source commit before staging plugins.",
    );
  }
  const catalog = readJson(path.join(root, "scripts/lib/official-external-plugin-catalog.json"));
  const officialNames = new Set(catalog.entries.map((entry) => entry.name));
  const excluded = collectRootPackageExcludedExtensionDirs({ cwd: root });
  const plugins = fs
    .readdirSync(path.join(root, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && excluded.has(entry.name))
    .map((entry) => ({ id: entry.name, directory: path.join(root, "extensions", entry.name) }))
    .filter(({ directory }) =>
      officialNames.has(readJson(path.join(directory, "package.json")).name),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (selectedIds) {
    for (const id of selectedIds) {
      if (!plugins.some((plugin) => plugin.id === id)) {
        throw new Error(`The official ${id} source plugin is missing.`);
      }
    }
    return {
      commit,
      releaseTag: null,
      pluginIds: [...new Set(selectedIds)].toSorted((a, b) => a.localeCompare(b)),
    };
  }
  const coreDependencies = runtimeDependencies(root);
  const addedDependencies = new Set();
  let allPluginBytes = 0;
  for (const plugin of plugins) {
    allPluginBytes += directoryBytes(path.join(root, "dist/extensions", plugin.id));
    for (const dependency of runtimeDependencies(plugin.directory)) {
      if (!coreDependencies.has(dependency)) {
        addedDependencies.add(dependency);
      }
    }
  }
  for (const dependency of addedDependencies) {
    allPluginBytes += directoryBytes(dependency);
  }
  const pluginIds = allPluginBytes > MAX_PLUGIN_BYTES ? ["codex"] : plugins.map(({ id }) => id);
  if (!plugins.some(({ id }) => id === "codex")) {
    throw new Error("The official Codex source plugin is missing.");
  }
  return { commit, releaseTag: null, pluginIds, allPluginBytes };
}

/** Stamp installed artifacts only, preserving release source and build-info bytes. */
export function stampDesktopRuntimePlugins(packageRoot, plan) {
  if (plan.pluginIds.length === 0) {
    return;
  }
  const file = path.join(packageRoot, "dist/build-info.json");
  const build = readJson(file);
  if (build.commit !== plan.commit) {
    throw new Error("Staged official plugins and runtime have different source commits.");
  }
  for (const id of plan.pluginIds) {
    const plugin = readJson(path.join(packageRoot, "dist/extensions", id, "package.json"));
    for (const entry of plugin.openclaw.extensions) {
      if (!fs.statSync(path.join(packageRoot, "dist/extensions", id, entry)).isFile()) {
        throw new Error(`Staged official plugin ${id} is missing ${entry}.`);
      }
    }
  }
  if (plan.pluginIds.includes("codex")) {
    removeStagedCodexVoiceHelper(packageRoot);
  }
  build.stagedOfficialPlugins = { commit: plan.commit, pluginIds: plan.pluginIds };
  fs.writeFileSync(file, `${JSON.stringify(build, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, root, planFile] = process.argv.slice(2);
  if (operation === "plan") {
    console.log(JSON.stringify(planDesktopRuntimePlugins(root)));
  } else if (operation === "stamp") {
    stampDesktopRuntimePlugins(root, readJson(planFile));
  } else {
    throw new Error(
      "Usage: desktop-runtime-plugins.mjs plan <source> | stamp <installed-package> <plan.json>",
    );
  }
}
