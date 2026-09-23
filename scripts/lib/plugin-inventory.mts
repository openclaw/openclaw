import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// Inventory export runs before dependency installation, including in sparse checkouts.
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stableStringify } from "../../packages/normalization-core/src/stable-stringify.ts";
import type { PluginManifest as RuntimePluginManifest } from "../../src/plugins/manifest-types.js";
import type { PackageManifest as RuntimePackageManifest } from "../../src/plugins/package-manifest.js";
import { collectExcludedPackagedExtensionDirs } from "./packaged-extension-dirs.mts";
import { assertPluginInventoryCoverage } from "./plugin-inventory-doc.mts";

export type PluginManifest = Partial<RuntimePluginManifest>;
export type PluginPackageJson = Partial<RuntimePackageManifest> & {
  openclaw?: RuntimePackageManifest["openclaw"] & {
    release?: Partial<Record<"publishToClawHub" | "publishToNpm", boolean>>;
  };
};
export type PluginStatus = "core" | "external" | "source";
export type PluginSourceEntry = {
  dirName: string;
  id: string;
  manifest: PluginManifest;
  packageJson: PluginPackageJson;
};

type MetadataSource = {
  directories: string[];
  readJson: (relativePath: string) => unknown;
};

function collectSourceEntries(source: MetadataSource): PluginSourceEntry[] {
  const entries: PluginSourceEntry[] = [];
  for (const dirName of source.directories.toSorted()) {
    const manifest = source.readJson(`extensions/${dirName}/openclaw.plugin.json`);
    if (manifest === undefined) {
      continue;
    }
    const packageMetadata = source.readJson(`extensions/${dirName}/package.json`);
    const packageJson = packageMetadata === undefined ? {} : packageMetadata;
    if (!isRecord(manifest) || !isRecord(packageJson)) {
      throw new Error(`plugin metadata must be a JSON object: extensions/${dirName}`);
    }
    const id = typeof manifest.id === "string" && manifest.id ? manifest.id : dirName;
    entries.push({ dirName, id, manifest, packageJson });
  }
  // Both readers enumerate manifests directly; reuse the inventory's duplicate-ID guard.
  assertPluginInventoryCoverage(entries, entries);
  return entries;
}

export function collectPluginSourceEntries(root: string): PluginSourceEntry[] {
  return collectSourceEntries({
    directories: fs.readdirSync(path.join(root, "extensions")),
    readJson: (relativePath) => {
      const file = path.join(root, relativePath);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    },
  });
}

export function resolvePluginStatus(
  { dirName, packageJson }: PluginSourceEntry,
  excludedDirs: Set<string>,
): PluginStatus {
  const release = packageJson.openclaw?.release;
  const hasInstallSpec =
    typeof packageJson.openclaw?.install?.clawhubSpec === "string" ||
    typeof packageJson.openclaw?.install?.npmSpec === "string";
  if (!excludedDirs.has(dirName)) {
    return "core";
  }
  if (release?.publishToClawHub === true || release?.publishToNpm === true || hasInstallSpec) {
    return "external";
  }
  return "source";
}

function readCommittedMetadata(root: string, requestedCommit?: string) {
  if (requestedCommit !== undefined && !/^[0-9a-f]{40}$/u.test(requestedCommit)) {
    throw new Error("--commit requires a full lowercase commit SHA");
  }
  // Read the selected object database only; ambient Git routing, replacement
  // refs or lazy fetching must not silently change a frozen inventory.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  });
  const deadline = Date.now() + 30_000;
  const git = (args: string[], input?: string) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) {
      throw new Error("plugin inventory source read timed out");
    }
    return execFileSync("git", ["-C", root, ...args], {
      env,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  const version = /^git version (\d+)\.(\d+)/u.exec(git(["--version"]).toString());
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 45)) {
    throw new Error("plugin inventory export requires Git 2.45 or newer (no lazy fetch)");
  }
  const commit = git(["rev-parse", "--verify", `${requestedCommit ?? "HEAD"}^{commit}`])
    .toString()
    .trim();
  const tree = git(["rev-parse", "--verify", `${commit}^{tree}`])
    .toString()
    .trim();
  const listed = git(["ls-tree", "-rz", tree, "--", "package.json", "extensions"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const manifestDirs = new Set(
    listed.flatMap((entry) => {
      const match = /\textensions\/([^/]+)\/openclaw\.plugin\.json$/u.exec(entry);
      return match ? [match[1]!] : [];
    }),
  );
  const blobs: Array<{ file: string; oid: string }> = [];
  for (const entry of listed) {
    const tab = entry.indexOf("\t");
    const file = entry.slice(tab + 1);
    if (file !== "package.json" && !manifestDirs.has(file.split("/")[1] ?? "")) {
      continue;
    }
    if (
      file !== "package.json" &&
      !/^extensions\/[^/]+\/(?:openclaw\.plugin|package)\.json$/u.test(file)
    ) {
      continue;
    }
    const match = /^100(?:644|755) blob ([0-9a-f]{40})$/u.exec(entry.slice(0, tab));
    if (!match) {
      throw new Error(`plugin metadata must be a regular Git blob: ${file}`);
    }
    blobs.push({ file, oid: match[1]! });
  }
  const output = git(["cat-file", "--batch"], blobs.map(({ oid }) => `${oid}\n`).join(""));
  const metadata = new Map<string, unknown>();
  let offset = 0;
  for (const { file, oid } of blobs) {
    const headerEnd = output.indexOf(10, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40}) blob (\d+)$/u.exec(header);
    const size = Number(match?.[2]);
    const end = headerEnd + 1 + size;
    if (
      headerEnd < offset ||
      match?.[1] !== oid ||
      !Number.isSafeInteger(size) ||
      output[end] !== 10
    ) {
      throw new Error(`could not read committed plugin metadata: ${file}`);
    }
    metadata.set(file, JSON.parse(output.subarray(headerEnd + 1, end).toString("utf8")));
    offset = end + 1;
  }
  if (offset !== output.length || !isRecord(metadata.get("package.json"))) {
    throw new Error("committed plugin inventory requires root package metadata");
  }
  return { commit, tree, metadata };
}

export function exportPluginInventory(root: string, requestedCommit?: string) {
  const { commit, tree, metadata } = readCommittedMetadata(root, requestedCommit);
  const directories = [...metadata.keys()].flatMap((file) => {
    const match = /^extensions\/([^/]+)\/openclaw\.plugin\.json$/u.exec(file);
    return match ? [match[1]!] : [];
  });
  const entries = collectSourceEntries({ directories, readJson: (file) => metadata.get(file) });
  const excludedDirs = collectExcludedPackagedExtensionDirs(
    metadata.get("package.json") as { files?: unknown[] },
  );
  const plugins = entries
    .map((entry) => {
      const { dirName, id, manifest, packageJson } = entry;
      const declaredSurfaces = Object.fromEntries(
        (
          [
            "channels",
            "providers",
            "contracts",
            "cliCommands",
            "commandAliases",
            "dashboard",
            "skills",
          ] as const
        )
          .filter((key) => manifest[key] !== undefined)
          .map((key) => [key, manifest[key]]),
      );
      return {
        id,
        path: `extensions/${dirName}`,
        manifestPath: `extensions/${dirName}/openclaw.plugin.json`,
        package: metadata.has(`extensions/${dirName}/package.json`)
          ? { name: packageJson.name ?? null, version: packageJson.version ?? null }
          : null,
        distribution: resolvePluginStatus(entry, excludedDirs),
        declaredSurfaces,
      };
    })
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const payload = {
    schemaVersion: 1,
    scope: "source-manifests",
    source: { kind: "git-tree", commit, tree },
    plugins,
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(stableStringify(payload)).digest("hex"),
  };
}
