// Bootstrap-safe ownership of OpenClaw executable identity and CLI invocation shape.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Packaging owns hashes; launch planning consumes only the artifact identity. */
export function readStandaloneRuntimeManifest(executable = process.execPath) {
  return readStandaloneManifest({ executable });
}

/** Resolve a peer package through the same manifest contract, including renamed executables. */
export function readStandaloneRuntimeManifestForRoot(runtimeRoot) {
  return readStandaloneManifest({ runtimeRoot });
}

function readStandaloneManifest({ executable, runtimeRoot }) {
  const location = executable ?? runtimeRoot;
  if (!path.isAbsolute(location)) {
    return undefined;
  }
  const root = path.dirname(location);
  const manifestPath = path.join(root, "manifest.json");
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Invalid standalone runtime manifest: ${manifestPath}`, { cause });
  }
  const nonBlank = (value) => typeof value === "string" && value.trim().length > 0;
  if (
    manifest?.schemaVersion !== 1 ||
    !["jit", "bytecode", "aot"].includes(manifest.mode) ||
    !nonBlank(manifest.executable?.path) ||
    !nonBlank(manifest.runtime?.path) ||
    !nonBlank(manifest.openclaw?.version) ||
    !nonBlank(manifest.bun?.version)
  ) {
    throw new Error(`Invalid standalone runtime manifest: ${manifestPath}`);
  }
  const executableRelative = path.relative(root, path.resolve(root, manifest.executable.path));
  const sidecarRelative = path.relative(root, path.resolve(root, manifest.runtime.path));
  if (
    path.isAbsolute(manifest.executable.path) ||
    !executableRelative ||
    executableRelative === ".." ||
    executableRelative.startsWith(`..${path.sep}`) ||
    (executable && path.resolve(root, manifest.executable.path) !== path.resolve(executable)) ||
    (runtimeRoot && path.resolve(root, manifest.runtime.path) !== path.resolve(runtimeRoot)) ||
    path.isAbsolute(manifest.runtime.path) ||
    !sidecarRelative ||
    sidecarRelative === ".." ||
    sidecarRelative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Invalid standalone runtime manifest: ${manifestPath}`);
  }
  return {
    schemaVersion: 1,
    mode: manifest.mode,
    executable: {
      path: manifest.executable.path,
      ...(nonBlank(manifest.executable.sha256) ? { sha256: manifest.executable.sha256 } : {}),
    },
    runtime: {
      path: manifest.runtime.path,
      ...(nonBlank(manifest.runtime.sha256) ? { sha256: manifest.runtime.sha256 } : {}),
    },
    openclaw: {
      version: manifest.openclaw.version,
      ...(nonBlank(manifest.openclaw.commit) ? { commit: manifest.openclaw.commit } : {}),
    },
    bun: { version: manifest.bun.version },
  };
}

/** The compiler publishes this fact before any embedded module is loaded. */
export function getEmbeddedStandaloneRuntimeRoot() {
  // eslint-disable-next-line no-underscore-dangle -- Matches the existing compiler bootstrap contract.
  const rootUrl = globalThis.__openclawStandaloneRootUrl;
  return typeof rootUrl === "string" ? fileURLToPath(rootUrl) : undefined;
}

function resolveStandaloneSidecarRoot(executable) {
  if (executable === process.execPath) {
    const embeddedRoot = getEmbeddedStandaloneRuntimeRoot();
    if (embeddedRoot !== undefined) {
      return embeddedRoot;
    }
  }
  const manifest = readStandaloneRuntimeManifest(executable);
  return manifest ? path.resolve(path.dirname(executable), manifest.runtime.path) : undefined;
}

export function isStandaloneRuntimeExecutable(executable = process.execPath) {
  return resolveStandaloneSidecarRoot(executable) !== undefined;
}

/** Disk-executed package-manager programs belong to the standalone sidecar. */
export function resolveStandaloneNpmCliPath() {
  const root = resolveStandaloneSidecarRoot(process.execPath);
  return root === undefined ? undefined : path.join(root, "npm", "bin", "npm-cli.js");
}

/** A compiled Bun executable needs this mode to execute a disk program as Bun. */
export function resolveRuntimeScriptEnv(env) {
  return isStandaloneRuntimeExecutable() ? { ...env, BUN_BE_BUN: "1" } : { ...env };
}

/** A null entry explicitly selects a CLI command; undefined inherits the current script. */
export function resolveOpenClawCliInvocation({
  execPath = process.execPath,
  entryPath,
  args = process.argv.slice(2),
  execArgv = process.execArgv,
} = {}) {
  const standaloneRoot = resolveStandaloneSidecarRoot(execPath);
  if (standaloneRoot !== undefined || entryPath === null) {
    if (standaloneRoot !== undefined && entryPath !== undefined && entryPath !== null) {
      const relative = path.relative(standaloneRoot, path.resolve(entryPath));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(
          "A standalone OpenClaw executable cannot run another installation's entry script.",
        );
      }
    }
    return { command: execPath, args: [...args] };
  }
  const entry = entryPath ?? process.argv[1];
  if (!entry) {
    throw new Error("Cannot invoke the loose OpenClaw CLI without an entry script.");
  }
  return { command: execPath, args: [...execArgv, entry, ...args] };
}
