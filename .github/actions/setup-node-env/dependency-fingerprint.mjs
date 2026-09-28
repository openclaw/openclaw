#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { pnpmLockfileDocuments } from "../../../scripts/lib/pnpm-lockfile-documents.mjs";

const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "pnpm:devPreinstall",
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
]);

// These audited root hooks call the files hashed in INSTALL_INPUT_FILES.
// Hook drift fails closed: an arbitrary lifecycle command can read any tracked
// source, so a semantic dependency fingerprint cannot safely infer its inputs.
const FILTERED_SCRIPT_CONTRACTS = new Map([
  [
    "package.json",
    {
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
      prepare: "node scripts/prepare-git-hooks.mjs",
    },
  ],
]);

const PNPM_HOOK_FILES = [".pnpmfile.mjs", ".pnpmfile.cjs", "pnpmfile.cjs"];

const INSTALL_INPUT_FILES = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ...PNPM_HOOK_FILES,
  ".github/actions/setup-node-env/dependency-fingerprint.mjs",
  ".github/actions/setup-node-env/install-dependencies.sh",
  "node-version.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/check-install-dependency-ownership.mjs",
  "scripts/postinstall-bundled-plugins.mjs",
  "scripts/lib/fs-safe-prebuild.mjs",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/lib/package-dist-imports.mjs",
  "scripts/lib/javascript-statements.mjs",
  "scripts/lib/package-lifecycle-marker.mjs",
  "scripts/preinstall-package-manager-warning.mjs",
  "scripts/prepare-git-hooks.mjs",
];

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function installLifecycleScripts(manifest) {
  if (
    !manifest.scripts ||
    typeof manifest.scripts !== "object" ||
    Array.isArray(manifest.scripts)
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(manifest.scripts).filter(([name]) => INSTALL_LIFECYCLE_SCRIPTS.has(name)),
  );
}

function hasAuditedLifecycleScripts(manifest, relativePath) {
  const installScripts = installLifecycleScripts(manifest);
  if (Object.keys(installScripts).length === 0) {
    return true;
  }
  return (
    JSON.stringify(canonicalize(installScripts)) ===
    JSON.stringify(canonicalize(FILTERED_SCRIPT_CONTRACTS.get(relativePath)))
  );
}

function normalizeManifest(manifest) {
  const normalized = { ...manifest };
  // Pnpm ignores OpenClaw's package metadata, and the audited install hooks do
  // not read it. Runtime schema/publication metadata must not relink the whole
  // workspace or hold canonical main fanout behind a cold dependency rebuild.
  delete normalized.openclaw;
  if (
    manifest.scripts &&
    typeof manifest.scripts === "object" &&
    !Array.isArray(manifest.scripts)
  ) {
    const installScripts = installLifecycleScripts(manifest);
    if (Object.keys(installScripts).length === 0) {
      delete normalized.scripts;
    } else {
      normalized.scripts = installScripts;
    }
  }
  return canonicalize(normalized);
}

function addRecord(hash, kind, relativePath, contents) {
  hash.update(kind);
  hash.update("\0");
  hash.update(relativePath);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(contents)));
  hash.update("\0");
  hash.update(contents);
  hash.update("\0");
}

function trackedPackageManifests(workspace) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"],
    {
      cwd: workspace,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`git ls-files failed: ${detail}`);
  }
  return result.stdout
    .split("\0")
    .filter((entry) => entry === "package.json" || entry.endsWith("/package.json"))
    .toSorted();
}

function frozenInstallManifests(workspace, manifests) {
  // Custom readPackage hooks can inspect manifests outside the locked graph.
  if (
    PNPM_HOOK_FILES.some((file) => existsSync(path.join(workspace, file))) ||
    Object.keys(process.env).some((name) => /^(?:pnpm|npm)_config_.*pnpmfile$/iu.test(name)) ||
    [".npmrc", "pnpm-workspace.yaml"].some((file) => {
      const config = path.join(workspace, file);
      return existsSync(config) && /pnpmfile/iu.test(readFileSync(config, "utf8"));
    })
  ) {
    return manifests;
  }
  const { dependencies } = pnpmLockfileDocuments(
    readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8"),
  );
  // Read only pnpm's generated importer keys before dependencies are available.
  // Unknown YAML shapes and local tarballs/directories retain the conservative
  // inventory; frozen reconciliation remains the authority for install validity.
  if (/(?:^|[\s'":{,])file:/u.test(dependencies)) {
    return manifests;
  }
  const section = dependencies.match(/^importers:\n([\s\S]*?)(?=^[^\s#]|(?![\s\S]))/mu)?.[1];
  if (!section) {
    return manifests;
  }
  const selected = new Set(["package.json"]);
  let importer;
  for (const line of section.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^  \S/u.test(line)) {
      const match = /^  ([a-zA-Z0-9_./-]+):(?: \{\})?$/u.exec(line);
      if (!match) {
        return manifests;
      }
      importer = match[1];
      selected.add(path.posix.join(importer, "package.json"));
    } else if (!/^    /u.test(line)) {
      return manifests;
    }
    const link = /^ +version: link:([a-zA-Z0-9_./-]+)$/u.exec(line);
    if (line.includes("link:")) {
      if (!link || !importer) {
        return manifests;
      }
      selected.add(path.posix.join(importer, link[1], "package.json"));
    }
  }
  return manifests.filter((manifest) => selected.has(manifest));
}

function computeDependencyFingerprint({ workspace, frozenLockfile }) {
  const hash = createHash("sha256");
  addRecord(hash, "contract", "frozen-lockfile", String(frozenLockfile));

  const trackedManifests = trackedPackageManifests(workspace);
  const manifests =
    frozenLockfile === "true"
      ? frozenInstallManifests(workspace, trackedManifests)
      : trackedManifests;
  if (manifests.length === 0) {
    throw new Error(`no tracked package.json files found under ${workspace}`);
  }
  const parsedManifests = manifests.map((relativePath) => {
    const source = readFileSync(path.join(workspace, relativePath), "utf8");
    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch (error) {
      throw new Error(`invalid JSON in ${relativePath}: ${error.message}`, { cause: error });
    }
    return { manifest, relativePath };
  });
  const unauditedLifecycleManifests = parsedManifests
    .filter(({ manifest, relativePath }) => !hasAuditedLifecycleScripts(manifest, relativePath))
    .map(({ relativePath }) => relativePath);
  if (unauditedLifecycleManifests.length > 0) {
    throw new Error(
      `unaudited install lifecycle scripts in ${unauditedLifecycleManifests.join(", ")}; update FILTERED_SCRIPT_CONTRACTS and INSTALL_INPUT_FILES`,
    );
  }
  for (const { manifest, relativePath } of parsedManifests) {
    addRecord(hash, "manifest", relativePath, JSON.stringify(normalizeManifest(manifest)));
  }

  for (const relativePath of INSTALL_INPUT_FILES) {
    const absolutePath = path.join(workspace, relativePath);
    let kind = "missing-file";
    let contents = "";
    try {
      if (statSync(absolutePath).isFile()) {
        kind = "file";
        contents = readFileSync(absolutePath);
      } else {
        throw new Error(`${relativePath} is not a regular file`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    addRecord(hash, kind, relativePath, contents);
  }

  return `v2-${hash.digest("hex")}`;
}

function parseArgs(argv) {
  let workspace = process.cwd();
  let frozenLockfile;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      workspace = path.resolve(argv[++index]);
    } else if (arg === "--frozen-lockfile") {
      frozenLockfile = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (frozenLockfile !== "true" && frozenLockfile !== "false") {
    throw new Error("--frozen-lockfile must be true or false");
  }
  return { frozenLockfile, workspace };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(computeDependencyFingerprint(parseArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
