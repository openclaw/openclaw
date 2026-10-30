#!/usr/bin/env node
// Offline build tooling: runtime identity belongs to the supplied package, not this checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { root as openRoot } from "@openclaw/fs-safe/root";
import * as tar from "tar";
import { collectNodeBootstrapDependencies } from "../src/gateway/worker-environments/node-bootstrap-dependencies.js";
import { verifyInstalledRuntimeImageInputs } from "./lib/installed-runtime-image-inputs.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "./lib/package-dist-imports.mjs";
import {
  installedPackagePath,
  validateBundledPackageName,
} from "./lib/package-installed-dependencies.mts";

type Manifest = Parameters<typeof collectNodeBootstrapDependencies>[1] & { files?: string[] };
type RuntimeBuild = { version: string; commit: string; buildId: string; builtAt?: string };
type PortableReceipt = { sha256: string; bytes: number; buildInfo: RuntimeBuild };
type RuntimeInput = {
  platform: string;
  arch: string;
  packageJsonSha256: string;
  lockfileSha256: string;
};
type InventoryEntry = {
  path: string;
  kind: "file" | "directory" | "link";
  mode: string;
  size?: number;
  sha256?: string;
  target?: string;
};
export type CompositionOptions = {
  package: string;
  packageReceipt: string;
  dependencyRoot: string;
  dependencyManifest: string;
  dependencyManifestSha256: string;
  qualifiedDependencyInput?: { receipt: { path: string; sha256: string } };
  sourceRoot: string;
  platform: string;
  arch: string;
  outputDir: string;
};
// These are owner-produced, hash-bound metadata; composition checks their identities below.
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}
async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function inventory(root: string, prefix = "", graphOnly = false): Promise<InventoryEntry[]> {
  const rows: InventoryEntry[] = [];
  const manifestTargets = new Set<string>();
  async function visit(relative: string) {
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    const row: InventoryEntry = {
      path: [prefix, relative.split(path.sep).join("/")].filter(Boolean).join("/"),
      kind: "file",
      mode: `0o${(stat.mode & 0o777).toString(8)}`,
    };
    if (stat.isSymbolicLink()) {
      row.kind = "link";
      row.target = await fs.readlink(file);
      const resolved = await fs.realpath(file);
      if (path.isAbsolute(row.target) || !inside(root, resolved)) {
        throw new Error(`Unsafe dependency link: ${row.path}`);
      }
      if (graphOnly && path.basename(file) === "package.json") {
        manifestTargets.add(
          [prefix, path.relative(root, resolved).split(path.sep).join("/")]
            .filter(Boolean)
            .join("/"),
        );
      }
    } else if (stat.isDirectory()) {
      row.kind = "directory";
    } else if (stat.isFile()) {
      row.size = stat.size;
      if (!graphOnly || path.basename(file) === "package.json") {
        row.sha256 = await sha256(file);
      }
    } else {
      throw new Error(`Unsupported runtime file: ${row.path}`);
    }
    rows.push(row);
    if (row.kind === "directory") {
      for (const name of (await fs.readdir(file)).toSorted()) {
        await visit(path.join(relative, name));
      }
    }
  }
  await visit("");
  for (const row of rows) {
    if (row.kind === "file" && manifestTargets.has(row.path) && !row.sha256) {
      row.sha256 = await sha256(
        path.join(root, prefix ? row.path.slice(prefix.length + 1) : row.path),
      );
    }
  }
  return rows;
}

async function verifyDependencyInput(options: CompositionOptions, runtimeInput: RuntimeInput) {
  if ((await sha256(options.dependencyManifest)) !== options.dependencyManifestSha256) {
    throw new Error("Dependency manifest digest mismatch");
  }
  const expected: InventoryEntry[] = (await fs.readFile(options.dependencyManifest, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const prefix = `node-runtime-dependencies/${options.platform}-${options.arch}`;
  const byPath = new Map(expected.map((row) => [row.path, row]));
  if (byPath.size !== expected.length) {
    throw new Error("Duplicate dependency inventory path");
  }
  const evidence = options.qualifiedDependencyInput?.receipt;
  if (evidence) {
    if (
      !/^[a-f0-9]{64}$/u.test(evidence.sha256) ||
      (await sha256(evidence.path)) !== evidence.sha256
    ) {
      throw new Error("Dependency qualification digest mismatch");
    }
    const prior = await readJson<{
      schema: string;
      compositionOnly: boolean;
      checks: { inputInventory: boolean };
      inputs: {
        dependencyManifest: { sha256: string; inputVerification: { mode: string } };
        sourcePackageSha256: string;
        sourceLockSha256: string;
      };
      target: { platform: string; arch: string };
    }>(evidence.path);
    if (
      prior.schema !== "openclaw.installed-runtime.v1" ||
      !prior.compositionOnly ||
      !prior.checks.inputInventory ||
      prior.inputs.dependencyManifest.inputVerification.mode !== "full-inventory" ||
      prior.inputs.dependencyManifest.sha256 !== options.dependencyManifestSha256 ||
      prior.inputs.sourcePackageSha256 !== runtimeInput.packageJsonSha256 ||
      prior.inputs.sourceLockSha256 !== runtimeInput.lockfileSha256 ||
      prior.target.platform !== options.platform ||
      prior.target.arch !== options.arch
    ) {
      throw new Error("Dependency qualification identity mismatch");
    }
  }
  // A prior receipt qualifies the manifest, not today's mutable donor. Always check
  // topology, modes and package manifests (including optional edges the planner skips).
  // Reuse hashes the remaining payload only after copying the selected closure.
  const actual = await inventory(options.dependencyRoot, prefix, Boolean(evidence));
  // Linux target symlinks do not grant access through their physical permission bits.
  // Keep that transport difference visible; all data, targets and other modes stay exact.
  if (expected.length !== actual.length) {
    throw new Error("Dependency inventory entry count mismatch");
  }
  let physicalSymlinkModeDifferences = 0;
  for (const row of actual) {
    const wanted = byPath.get(row.path);
    if (
      !wanted ||
      (["kind", "mode", "size", "sha256", "target"] as const).some(
        (key) =>
          !(key === "mode" && row.kind === "link") &&
          !(key === "sha256" && evidence && row.sha256 === undefined) &&
          wanted[key] !== row[key],
      )
    ) {
      throw new Error(`Dependency inventory mismatch: ${row.path}`);
    }
    if (row.kind === "link" && wanted.mode !== row.mode) {
      physicalSymlinkModeDifferences++;
    }
  }
  return {
    entries: byPath,
    physicalSymlinkModeDifferences,
    inputVerification: evidence
      ? {
          mode: "qualified-reuse" as const,
          receipt: evidence,
          scope: "graph-metadata-and-selected-content" as const,
        }
      : { mode: "full-inventory" as const },
  };
}

async function materializeClosure(
  app: string,
  dependencyRoot: string,
  target: { platform: string; arch: string },
  admittedEntries: Map<string, InventoryEntry>,
  sourceManifest: Manifest,
  verifySelected: boolean,
) {
  // Temporary resolver links exist only in the new, unpublished output. The canonical planner
  // sees packaged bundled dependencies first and the frozen-lock Linux graph for everything else.
  const links: string[] = [];
  async function prepare(
    root: string,
    source: string | undefined,
    manifest: Manifest,
    dependencyOwners: ReadonlyMap<string, string> = new Map(),
  ) {
    for (const name of Object.keys({
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (name === "openclaw") {
        continue;
      }
      if (!source) {
        validateBundledPackageName(name);
      }
      const owner = dependencyOwners.get(name) ?? source;
      const installed = owner ? await installedPackagePath(owner, name) : undefined;
      const resolved = installed ? await fs.realpath(installed) : undefined;
      if (resolved && !inside(dependencyRoot, resolved)) {
        throw new Error("Dependency escapes qualified root: " + name);
      }
      const destination = path.join(root, "node_modules", name);
      const packaged = await fs.lstat(destination).then(
        () => true,
        () => false,
      );
      if (packaged) {
        const bundled = await readJson<Manifest>(path.join(destination, "package.json"));
        if (resolved) {
          const donor = await readJson<Manifest>(path.join(resolved, "package.json"));
          if (donor.name !== bundled.name || donor.version !== bundled.version) {
            throw new Error("Bundled dependency source identity mismatch: " + name);
          }
        }
        // Portable bundles can omit target-specific optional payloads. Preserve
        // their bytes, but resolve missing edges from the matching input importer.
        await prepare(destination, resolved, bundled);
      } else if (resolved) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.symlink(resolved, destination, "dir");
        links.push(destination);
      }
    }
  }
  const rootManifest: Manifest = await readJson<Manifest>(path.join(app, "package.json"));
  const dependencyRoots = new Map<string, string>();
  const dependencySources = new Map<string, string>();
  const roots = [{ root: app, manifest: rootManifest, prefix: "" }];
  const plugins = path.join(app, "dist/extensions");
  for (const id of await fs.readdir(plugins).catch(() => [] as string[])) {
    const packagedRoot = path.join(plugins, id);
    const manifest = await readJson<Manifest>(path.join(packagedRoot, "package.json")).catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      },
    );
    if (!manifest) {
      continue;
    }
    const root = path.join(app, "extensions", id);
    await fs.mkdir(root, { recursive: true });
    await fs.copyFile(path.join(packagedRoot, "package.json"), path.join(root, "package.json"));
    // Keep portable plugin bundles authoritative, just like root bundles. The
    // finalizer links this installed owner back under dist after postinstall.
    const bundled = path.join(packagedRoot, "node_modules");
    try {
      await fs.rename(bundled, path.join(root, "node_modules"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    const source = path.join(dependencyRoot, "extensions", id);
    await prepare(root, source, manifest);
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (
        !Object.hasOwn(sourceManifest.dependencies ?? {}, name) &&
        !Object.hasOwn(sourceManifest.optionalDependencies ?? {}, name)
      ) {
        dependencySources.set(name, source);
        dependencyRoots.set(name, root);
      }
    }
    // OpenClaw is supplied by the enclosing package, never a second installed core.
    const peerDependencies = { ...manifest.peerDependencies };
    delete peerDependencies.openclaw;
    roots.push({ root, manifest: { ...manifest, peerDependencies }, prefix: `extensions/${id}/` });
  }
  // Root production dependencies retain root ownership. Promoted plugin-only
  // dependencies use their declared importer, not an unrelated root dev install.
  // Portable bundles still own their bytes; only missing edges use that donor.
  for (const name of dependencyRoots.keys()) {
    if (
      await fs.lstat(path.join(app, "node_modules", name)).then(
        () => true,
        () => false,
      )
    ) {
      dependencyRoots.delete(name);
    }
  }
  await prepare(app, dependencyRoot, rootManifest, dependencySources);
  const plans = [];
  for (const root of roots) {
    const plan = await collectNodeBootstrapDependencies(
      root.root,
      root.manifest,
      target,
      root.prefix ? undefined : dependencyRoots,
    );
    for (const entry of plan) {
      if (!inside(app, entry.root) && !inside(dependencyRoot, entry.root)) {
        throw new Error("Unqualified dependency source");
      }
      plans.push({ ...entry, destination: path.join(app, root.prefix, entry.prefix) });
    }
  }
  for (const link of links) {
    await fs.unlink(link);
  }
  for (const entry of plans) {
    if (path.resolve(entry.destination) === entry.root) {
      continue;
    } // Preserve the archive's bundled content.
    const exists = await fs.lstat(entry.destination).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new Error(`Dependency placement collision: ${path.relative(app, entry.destination)}`);
    }
    const selected = new Map<string, InventoryEntry>();
    await fs.cp(entry.root, entry.destination, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => {
        // The planner owns installed dependencies, not nested package implementation trees.
        if (path.relative(entry.root, source) === "node_modules") {
          return false;
        }
        const relative = path.relative(dependencyRoot, source).split(path.sep).join("/");
        if (inside(dependencyRoot, source)) {
          const wanted = admittedEntries.get(
            "node-runtime-dependencies/" + target.platform + "-" + target.arch + "/" + relative,
          );
          if (!wanted) {
            throw new Error("Dependency absent from admitted manifest: " + relative);
          }
          selected.set(path.relative(entry.root, source).split(path.sep).join("/"), wanted);
        }
        return true;
      },
    });
    if (verifySelected && selected.size) {
      const copied = await inventory(entry.destination);
      if (copied.length !== selected.size) {
        throw new Error("Dependency inventory selected entry count mismatch");
      }
      for (const row of copied) {
        const wanted = selected.get(row.path);
        if (
          !wanted ||
          (["kind", "mode", "size", "sha256", "target"] as const).some(
            (key) => !(key === "mode" && row.kind === "link") && row[key] !== wanted[key],
          )
        ) {
          throw new Error("Dependency inventory selected content mismatch: " + row.path);
        }
      }
    }
  }
}

async function prepareTargetHelpers(app: string, sourceRoot: string) {
  const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bootstrap = path.join(app, ".runtime-bootstrap");
  // The existing owner selects package-declared bootstrap scripts; extra build helpers
  // retain their exact frozen-source import closure rather than a Factory-side copy.
  execFileSync(process.execPath, [
    path.join(sourceRoot, "scripts/docker/copy-bootstrap-scripts.mjs"),
    bootstrap,
  ]);
  const pending = [
    "scripts/finalize-installed-runtime.mjs",
    "scripts/prune-docker-plugin-dist.mjs",
    "scripts/check-package-dist-imports.mjs",
    "scripts/docker/verify-fs-safe-native.mjs",
  ];
  const copied = new Set<string>();
  while (pending.length) {
    const relative = pending.pop()!;
    if (copied.has(relative)) {
      continue;
    }
    const source = path.join(
      relative === "scripts/finalize-installed-runtime.mjs" ? toolingRoot : sourceRoot,
      relative,
    );
    const text = await fs.readFile(source, "utf8");
    const destination = path.join(bootstrap, relative);
    if (!inside(bootstrap, destination)) {
      throw new Error("Unsafe build-helper import");
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    copied.add(relative);
    for (const edge of collectPackageDistImports({
      files: [relative],
      readText: () => text,
      includeTypeScript: true,
    })) {
      if (edge.importedPath.startsWith(".")) {
        throw new Error("Build-helper import escapes root");
      }
      pending.push(edge.importedPath);
    }
  }
  return {
    root: "/app/.runtime-bootstrap",
    finalize: "scripts/finalize-installed-runtime.mjs",
    prune: "scripts/prune-docker-plugin-dist.mjs",
    importCheck: "scripts/check-package-dist-imports.mjs",
    closure: [...copied].toSorted(),
  };
}

export async function composeInstalledRuntime(input: CompositionOptions) {
  let options = input;
  if (options.platform !== "linux" || options.arch !== "x64") {
    throw new Error("Supported composition target is linux/x64");
  }
  const output = path.join(
    await fs.realpath(path.dirname(path.resolve(options.outputDir))),
    path.basename(options.outputDir),
  );
  const dependencyRoot = await fs.realpath(options.dependencyRoot);
  const sourceRoot = await fs.realpath(options.sourceRoot);
  for (const inputPath of [
    dependencyRoot,
    sourceRoot,
    options.package,
    options.packageReceipt,
    options.dependencyManifest,
    ...(options.qualifiedDependencyInput ? [options.qualifiedDependencyInput.receipt.path] : []),
  ].map((value) => path.resolve(value))) {
    if (inside(inputPath, output) || inside(output, inputPath)) {
      throw new Error("Output overlaps a composition input");
    }
  }
  options = { ...options, dependencyRoot, sourceRoot };
  const receipt = await readJson<PortableReceipt>(options.packageReceipt);
  const packageSha = await sha256(options.package);
  if (receipt.sha256 !== packageSha || receipt.bytes !== (await fs.stat(options.package)).size) {
    throw new Error("Portable package digest/size mismatch");
  }
  const runtimeInput = await readJson<RuntimeInput>(
    path.join(dependencyRoot, "runtime-input.json"),
  );
  if (
    runtimeInput.packageJsonSha256 !== (await sha256(path.join(dependencyRoot, "package.json"))) ||
    runtimeInput.lockfileSha256 !== (await sha256(path.join(dependencyRoot, "pnpm-lock.yaml"))) ||
    runtimeInput.platform !== options.platform ||
    runtimeInput.arch !== options.arch ||
    runtimeInput.packageJsonSha256 !== (await sha256(path.join(sourceRoot, "package.json"))) ||
    runtimeInput.lockfileSha256 !== (await sha256(path.join(sourceRoot, "pnpm-lock.yaml")))
  ) {
    throw new Error("Linux dependency source identity mismatch");
  }
  const { entries: admittedEntries, ...dependencyInput } = await verifyDependencyInput(
    options,
    runtimeInput,
  );
  await fs.mkdir(output); // Exclusive new output; never merge with a prior install.
  const extracted = path.join(output, "extract");
  const workspace = await fs.mkdtemp(path.join(output, ".package-extraction-"));
  await fs.chmod(workspace, 0o700);
  let settled = false;
  try {
    // Sync node-tar runs only in the existing supervised tooling process. Join
    // the whole tree before publishing or removing its parent-owned workspace.
    const exit = await runManagedCommand({
      bin: process.execPath,
      args: [
        fileURLToPath(new URL("./check-openclaw-package-tarball.mjs", import.meta.url)),
        "--extract-only",
        workspace,
        packageSha,
        String(receipt.bytes),
        path.resolve(options.package),
      ],
      // Keep native inspector snapshots inside the parent-owned cleanup boundary.
      env: { ...process.env, TMPDIR: workspace, TMP: workspace, TEMP: workspace },
      stdio: ["ignore", "inherit", "inherit"],
      timeoutMs: 120_000,
      requireProcessTreeExit: true,
    });
    settled = true;
    if (exit !== 0) {
      throw new Error("Package extraction failed (exit " + exit + ")");
    }
    await (
      await openRoot(output)
    ).move(path.basename(workspace) + "/extract", "extract", { overwrite: false });
  } catch (error) {
    // Managed timeout/abort errors are returned only after positive tree exit.
    // Unknown cleanup failures retain the workspace for the process owner.
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ETIMEDOUT" || error.code === "ABORT_ERR")
    ) {
      settled = true;
    }
    throw error;
  } finally {
    if (settled) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
  if (JSON.stringify(await fs.readdir(extracted)) !== '["package"]') {
    throw new Error("Expected one package/ archive root");
  }
  const app = path.join(output, "app");
  await fs.rename(path.join(extracted, "package"), app);
  await fs.rmdir(extracted);
  const manifest = await readJson<Manifest>(path.join(app, "package.json"));
  const sourceManifest = await readJson<Manifest>(path.join(sourceRoot, "package.json"));
  const build = await readJson<RuntimeBuild>(path.join(app, "dist/build-info.json"));
  const sourceBuild = await readJson<RuntimeBuild>(path.join(sourceRoot, "dist/build-info.json"));
  if (
    manifest.name !== "openclaw" ||
    !/^[a-f0-9]{40}$/u.test(build.commit) ||
    !build.buildId ||
    manifest.version !== sourceManifest.version ||
    build.commit !== sourceBuild.commit ||
    build.buildId !== sourceBuild.buildId ||
    build.version !== sourceBuild.version ||
    build.version !== receipt.buildInfo.version ||
    build.commit !== receipt.buildInfo.commit ||
    build.buildId !== receipt.buildInfo.buildId ||
    build.version !== manifest.version
  ) {
    throw new Error("Portable runtime identity mismatch");
  }
  const closureStarted = performance.now();
  await materializeClosure(
    app,
    dependencyRoot,
    { platform: options.platform, arch: options.arch },
    admittedEntries,
    sourceManifest,
    Boolean(options.qualifiedDependencyInput),
  );
  const toolingHelpers = await prepareTargetHelpers(app, sourceRoot);
  console.error(
    `[compose] dependency closure and helpers: ${Math.round(performance.now() - closureStarted)}ms`,
  );
  // Keep lifecycle pending for the real Linux image: native probes must not run on the build host.
  await fs.writeFile(path.join(app, ".openclaw-lifecycle-pending"), "");
  await verifyDependencyInput(options, runtimeInput);
  if ((await sha256(options.package)) !== packageSha) {
    throw new Error("Portable input changed during composition");
  }
  const outputManifest = path.join(output, "installed-runtime.manifest.jsonl");
  const inventoryStarted = performance.now();
  const outputRows = await inventory(app, "app");
  console.error(
    `[compose] output inventory: ${Math.round(performance.now() - inventoryStarted)}ms`,
  );
  const files = outputRows
    .filter((row) => row.kind === "file" && row.path.startsWith("app/dist/"))
    .map((row) => row.path.slice(4));
  const importsStarted = performance.now();
  const errors = collectPackageDistImportErrors({
    files,
    readText: (relative: string) => readFileSync(path.join(app, relative), "utf8"),
  });
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  console.error(`[compose] relative imports: ${Math.round(performance.now() - importsStarted)}ms`);
  await fs.writeFile(
    outputManifest,
    outputRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const archive = path.join(output, "installed-runtime.tgz");
  const archiveStarted = performance.now();
  await tar.create({ cwd: output, file: archive, gzip: true, portable: true, noMtime: true }, [
    "app",
  ]);
  console.error(`[compose] archive creation: ${Math.round(performance.now() - archiveStarted)}ms`);
  const result = {
    schema: "openclaw.installed-runtime.v1",
    compositionOnly: true,
    runtime: build,
    target: {
      platform: options.platform,
      arch: options.arch,
      abi: "requires-target-acceptance",
      libc: "requires-target-acceptance",
    },
    tooling: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        encoding: "utf8",
      }).trim(),
      scriptSha256: await sha256(fileURLToPath(import.meta.url)),
    },
    inputs: {
      portablePackage: { sha256: packageSha, bytes: receipt.bytes },
      dependencyManifest: { sha256: options.dependencyManifestSha256, ...dependencyInput },
      sourcePackageSha256: runtimeInput.packageJsonSha256,
      sourceLockSha256: runtimeInput.lockfileSha256,
      sourceDockerfileSha256: await sha256(path.join(sourceRoot, "Dockerfile")),
      sourceBuildInfoSha256: await sha256(path.join(sourceRoot, "dist/build-info.json")),
    },
    helpers: toolingHelpers,
    archive: {
      path: archive,
      sha256: await sha256(archive),
      bytes: (await fs.stat(archive)).size,
      prefix: "app/",
    },
    manifest: {
      path: outputManifest,
      sha256: await sha256(outputManifest),
      entries: outputRows.length,
    },
    lifecycle: {
      status: "target-required",
      completed: false,
      command: "node /app/.runtime-bootstrap/scripts/finalize-installed-runtime.mjs /app",
    },
    checks: {
      packageIdentity: true,
      inputInventory: !options.qualifiedDependencyInput,
      selectedDependencyContent: true,
      relativeImportClosure: true,
      externalLinks: false,
    },
    requiredTargetChecks: [
      "native-prebuild-availability-and-load-before-lifecycle-no-npm",
      "packaged-postinstall",
      "selected-plugin-pruning",
      "package-imports",
      "bootstrap-scripts",
      "entrypoint",
      "provider-plugin-identity",
      "runtime-export",
    ],
  };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

export type InstalledRuntimeVerificationOptions = {
  compositionRoot: string;
  receiptSha256: string;
  portablePackageSha256: string;
  expectedRuntime: Pick<RuntimeBuild, "version" | "commit" | "buildId">;
};

async function resolveInstalledRuntimeComposition(
  options: InstalledRuntimeVerificationOptions,
  fullInventory: boolean,
) {
  for (const digest of [options.receiptSha256, options.portablePackageSha256]) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error("Expected lowercase SHA256 identity");
    }
  }
  const compositionRoot = await fs.realpath(options.compositionRoot);
  const receiptPath = path.join(compositionRoot, "receipt.json");
  const archivePath = path.join(compositionRoot, "installed-runtime.tgz");
  const manifestPath = path.join(compositionRoot, "installed-runtime.manifest.jsonl");
  const appRoot = path.join(compositionRoot, "app");
  for (const file of [receiptPath, archivePath, manifestPath, appRoot]) {
    if ((await fs.lstat(file)).isSymbolicLink()) {
      throw new Error("Composition roots and metadata must not be links");
    }
  }
  if ((await sha256(receiptPath)) !== options.receiptSha256) {
    throw new Error("Composition receipt digest mismatch");
  }
  const receipt = await readJson<Awaited<ReturnType<typeof composeInstalledRuntime>>>(receiptPath);
  if (
    receipt.schema !== "openclaw.installed-runtime.v1" ||
    !receipt.compositionOnly ||
    receipt.inputs.portablePackage.sha256 !== options.portablePackageSha256 ||
    receipt.target.platform !== "linux" ||
    receipt.target.arch !== "x64" ||
    receipt.target.abi !== "requires-target-acceptance" ||
    receipt.target.libc !== "requires-target-acceptance" ||
    receipt.lifecycle.status !== "target-required" ||
    receipt.lifecycle.completed ||
    receipt.archive.prefix !== "app/" ||
    !/^[a-f0-9]{40}$/u.test(options.expectedRuntime.commit) ||
    !options.expectedRuntime.version ||
    !options.expectedRuntime.buildId
  ) {
    throw new Error("Unsupported composition identity or lifecycle");
  }
  const build = await readJson<RuntimeBuild>(path.join(appRoot, "dist/build-info.json"));
  const manifest = await readJson<Manifest>(path.join(appRoot, "package.json"));
  if (
    manifest.name !== "openclaw" ||
    manifest.version !== build.version ||
    (["version", "commit", "buildId"] as const).some(
      (key) =>
        receipt.runtime[key] !== options.expectedRuntime[key] ||
        build[key] !== options.expectedRuntime[key],
    )
  ) {
    throw new Error("Installed runtime identity mismatch");
  }
  if (
    (await sha256(archivePath)) !== receipt.archive.sha256 ||
    (await fs.stat(archivePath)).size !== receipt.archive.bytes ||
    (await sha256(manifestPath)) !== receipt.manifest.sha256
  ) {
    throw new Error("Composition archive/manifest identity mismatch");
  }
  const expected: InventoryEntry[] = (await fs.readFile(manifestPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const byPath = new Map(expected.map((row) => [row.path, row]));
  if (expected.length !== receipt.manifest.entries || byPath.size !== expected.length) {
    throw new Error("Installed runtime inventory entry count mismatch");
  }
  if (fullInventory) {
    const actual = await inventory(appRoot, "app");
    if (actual.length !== expected.length) {
      throw new Error("Installed runtime inventory entry count mismatch");
    }
    for (const row of actual) {
      const wanted = byPath.get(row.path);
      if (
        !wanted ||
        (["kind", "mode", "size", "sha256", "target"] as const).some(
          (key) => row[key] !== wanted[key],
        )
      ) {
        throw new Error(`Installed runtime inventory mismatch: ${row.path}`);
      }
    }
  }
  if (!fullInventory) {
    if (
      !receipt.checks.packageIdentity ||
      !receipt.checks.relativeImportClosure ||
      !(receipt.checks.inputInventory || receipt.checks.selectedDependencyContent)
    ) {
      throw new Error("Composition qualification is incomplete");
    }
    // Only these small files are read during recipe admission. Bind those reads to
    // the inventory; Docker consumes the archive, never the unchecked app payload.
    const readPaths = new Set([
      "app/package.json",
      "app/dist/build-info.json",
      ...expected
        .filter((row) => path.posix.dirname(row.path) === "app" && row.path.endsWith(".mjs"))
        .map((row) => row.path),
      ...receipt.helpers.closure.map((relative) => "app/.runtime-bootstrap/" + relative),
    ]);
    for (const relative of readPaths) {
      const wanted = byPath.get(relative);
      const file = path.join(compositionRoot, relative);
      if (
        !inside(appRoot, file) ||
        wanted?.kind !== "file" ||
        !inside(appRoot, await fs.realpath(file)) ||
        (await sha256(file)) !== wanted.sha256
      ) {
        throw new Error("Installed runtime recipe input mismatch: " + relative);
      }
    }
  }
  const imageAssets = await verifyInstalledRuntimeImageInputs({
    appRoot,
    nativeToolRoot: fileURLToPath(new URL("../", import.meta.url)),
    runtimeCommit: options.expectedRuntime.commit,
    sourceLockSha256: receipt.inputs.sourceLockSha256,
    availableFiles: expected.filter((row) => row.kind === "file").map((row) => row.path.slice(4)),
  });
  const files = (fullInventory ? expected : [])
    .filter((row) => row.kind === "file" && row.path.startsWith("app/dist/"))
    .map((row) => row.path.slice(4));
  for (const relative of receipt.helpers.closure) {
    const helper = path.join(appRoot, ".runtime-bootstrap", relative);
    if (!inside(path.join(appRoot, ".runtime-bootstrap"), helper)) {
      throw new Error("Unsafe build-helper path");
    }
    files.push(`.runtime-bootstrap/${relative}`);
  }
  const errors = collectPackageDistImportErrors({
    files,
    readText: (relative: string) => readFileSync(path.join(appRoot, relative), "utf8"),
  });
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  await fs.access(path.join(appRoot, ".openclaw-lifecycle-pending"));
  return {
    schema: fullInventory
      ? "openclaw.installed-runtime.verification.v1"
      : "openclaw.installed-runtime.archive-admission.v1",
    verification: { mode: fullInventory ? "full-inventory" : "archive-bound" },
    compositionOnly: true,
    compositionRoot,
    appRoot,
    receipt: { path: receiptPath, sha256: options.receiptSha256 },
    archive: { ...receipt.archive, path: archivePath },
    manifest: { ...receipt.manifest, path: manifestPath },
    runtime: receipt.runtime,
    target: receipt.target,
    helpers: receipt.helpers,
    imageAssets,
    lifecycle: receipt.lifecycle,
    requiredTargetChecks: receipt.requiredTargetChecks,
  };
}

export async function verifyInstalledRuntimeComposition(
  options: InstalledRuntimeVerificationOptions,
) {
  return resolveInstalledRuntimeComposition(options, true);
}

export async function resolveInstalledRuntimeImageRecipe(
  options: InstalledRuntimeVerificationOptions & { imageInput?: "directory" | "archive" },
) {
  const archive = options.imageInput === "archive";
  const composition = await resolveInstalledRuntimeComposition(options, !archive);
  const dockerfilePath = fileURLToPath(new URL("../Dockerfile", import.meta.url));
  return {
    schema: "openclaw.installed-runtime.image-recipe.v1",
    composition,
    dockerfile: { path: dockerfilePath, sha256: await sha256(dockerfilePath) },
    target: "openclaw-runtime",
    buildArgs: {
      OPENCLAW_RUNTIME_ASSETS: "installed-runtime-assets",
      ...(archive
        ? {
            OPENCLAW_INSTALLED_RUNTIME_INPUT: "installed-runtime-archive-input",
            OPENCLAW_INSTALLED_RUNTIME_SHA256: composition.archive.sha256,
          }
        : {}),
    },
    namedContexts: { openclaw_installed_runtime: composition.compositionRoot },
    requiredTargetChecks: composition.requiredTargetChecks,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const composeNames = [
    "package",
    "package-receipt",
    "dependency-root",
    "dependency-manifest",
    "dependency-manifest-sha256",
    "source-root",
    "platform",
    "arch",
    "output-dir",
  ];
  const verificationNames = [
    "composition-root",
    "receipt-sha256",
    "portable-package-sha256",
    "runtime-version",
    "runtime-commit",
    "runtime-build-id",
  ];
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        ...composeNames,
        ...verificationNames,
        "operation",
        "image-input",
        "qualified-dependency-receipt",
        "qualified-dependency-receipt-sha256",
      ].map((name) => [name, { type: "string" as const }]),
    ),
    strict: true,
  });
  const operation = values.operation ?? "compose";
  if (!["compose", "verify", "image-recipe"].includes(operation)) {
    throw new Error("Unknown composition operation");
  }
  for (const name of operation === "compose" ? composeNames : verificationNames) {
    if (!values[name]) {
      throw new Error(`Missing --${name}`);
    }
  }
  const imageInput = values["image-input"];
  if (
    imageInput &&
    (operation !== "image-recipe" || !["directory", "archive"].includes(imageInput))
  ) {
    throw new Error("--image-input requires image-recipe and directory or archive");
  }
  if (operation !== "compose") {
    const options = {
      compositionRoot: values["composition-root"]!,
      receiptSha256: values["receipt-sha256"]!,
      portablePackageSha256: values["portable-package-sha256"]!,
      expectedRuntime: {
        version: values["runtime-version"]!,
        commit: values["runtime-commit"]!,
        buildId: values["runtime-build-id"]!,
      },
    };
    console.log(
      JSON.stringify(
        await (operation === "verify"
          ? verifyInstalledRuntimeComposition(options)
          : resolveInstalledRuntimeImageRecipe({
              ...options,
              imageInput: imageInput === "archive" ? "archive" : "directory",
            })),
      ),
    );
  } else {
    const qualified = values["qualified-dependency-receipt"];
    const qualifiedSha256 = values["qualified-dependency-receipt-sha256"];
    if (Boolean(qualified) !== Boolean(qualifiedSha256)) {
      throw new Error("Qualified dependency receipt requires its path and SHA256");
    }
    const result = await composeInstalledRuntime({
      qualifiedDependencyInput:
        qualified && qualifiedSha256
          ? { receipt: { path: qualified, sha256: qualifiedSha256 } }
          : undefined,
      package: values.package!,
      packageReceipt: values["package-receipt"]!,
      dependencyRoot: values["dependency-root"]!,
      dependencyManifest: values["dependency-manifest"]!,
      dependencyManifestSha256: values["dependency-manifest-sha256"]!,
      sourceRoot: values["source-root"]!,
      platform: values.platform!,
      arch: values.arch!,
      outputDir: values["output-dir"]!,
    });
    console.log(JSON.stringify(result));
  }
}
