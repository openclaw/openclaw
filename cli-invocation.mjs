// Bootstrap-safe ownership of OpenClaw executable identity and CLI invocation shape.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_PARENT_BOUND_PRELOAD, CLI_RESPAWN_PARENT_ENV } from "./cli-parent-lifetime.mjs";
import { hasNodeStartupHooks } from "./node-runtime-env.mjs";

/** Packaging owns hashes; launch planning consumes only the artifact identity. */
export function readStandaloneRuntimeManifest(executable = process.execPath) {
  return readStandaloneManifest({ executable });
}

/** Resolve a peer package through the same manifest contract, including renamed executables. */
export function readStandaloneRuntimeManifestForRoot(runtimeRoot) {
  return readStandaloneManifest({ runtimeRoot });
}

/** The executing image owns its build facts, even if its sidecar is replaced. */
export function getStandaloneRuntimeBuild(executable = process.execPath) {
  if (executable === process.execPath) {
    // eslint-disable-next-line no-underscore-dangle -- Compiler-owned bootstrap contract.
    const embedded = globalThis.__openclawStandaloneBuildInfo;
    if (embedded !== undefined) {
      return embedded;
    }
  }
  return readStandaloneManifest({ executable, includeBuild: true });
}

function projectStandaloneBuildInfo(value) {
  const nonBlank = (text) => typeof text === "string" && text.trim().length > 0;
  const stringList = (items) => Array.isArray(items) && items.every(nonBlank);
  const result = {
    mode: value.mode,
    openclaw: {
      version: value.openclaw.version,
      ...(nonBlank(value.openclaw.commit) ? { commit: value.openclaw.commit } : {}),
    },
    bun: { version: value.bun.version },
  };
  for (const key of ["revision", "commit", "executableSha256"]) {
    if (nonBlank(value.bun[key])) {
      result.bun[key] = value.bun[key];
    }
  }
  if (value.build !== undefined) {
    const { id, flavor, pluginSetSha256, moduleGraphSha256 } = value.build;
    if (
      !nonBlank(id) ||
      !["standard", "support"].includes(flavor) ||
      !/^[a-f0-9]{64}$/.test(pluginSetSha256) ||
      !/^[a-f0-9]{64}$/.test(moduleGraphSha256)
    ) {
      throw new Error("Invalid standalone build provenance");
    }
    result.build = { id, flavor, pluginSetSha256, moduleGraphSha256 };
    if (value.build.debugEntry !== undefined) {
      const entry = value.build.debugEntry;
      if (
        typeof entry !== "string" ||
        !entry.startsWith("debug/") ||
        entry.includes("\\") ||
        entry.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error("Invalid standalone debugger entry");
      }
      result.build.debugEntry = entry;
    }
  }
  if (value.target !== undefined) {
    if (!nonBlank(value.target.platform) || !nonBlank(value.target.arch)) {
      throw new Error("Invalid standalone build target");
    }
    result.target = { platform: value.target.platform, arch: value.target.arch };
  }
  if (value.plugins !== undefined) {
    if (!stringList(value.plugins.embedded) || !stringList(value.plugins.omitted)) {
      throw new Error("Invalid standalone plugin inventory");
    }
    result.plugins = { embedded: [...value.plugins.embedded], omitted: [...value.plugins.omitted] };
  }
  if (value.nativeModules !== undefined) {
    if (
      !Array.isArray(value.nativeModules) ||
      value.nativeModules.some(
        (item) =>
          !item ||
          !nonBlank(item.name) ||
          !nonBlank(item.version) ||
          !stringList(item.artifacts) ||
          item.qualification !== "unverified" ||
          !nonBlank(item.backend),
      )
    ) {
      throw new Error("Invalid standalone native inventory");
    }
    result.nativeModules = value.nativeModules.map(
      ({ name, version, artifacts, qualification, backend }) => ({
        name,
        version,
        artifacts: [...artifacts],
        qualification,
        backend,
      }),
    );
  }
  return result;
}

function readStandaloneManifest({ executable, runtimeRoot, includeBuild = false }) {
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
    ...(includeBuild ? projectStandaloneBuildInfo(manifest) : {}),
  };
}

/** The compiler publishes this fact before any embedded module is loaded. */
export function getEmbeddedStandaloneRuntimeRoot() {
  // eslint-disable-next-line no-underscore-dangle -- Matches the existing compiler bootstrap contract.
  const rootUrl = globalThis.__openclawStandaloneRootUrl;
  return typeof rootUrl === "string" ? fileURLToPath(rootUrl) : undefined;
}

/** Image membership comes from the compiler's module inventory, never disk contents. */
export function isEmbeddedStandaloneModule(modulePath) {
  const filename = modulePath.startsWith("file:") ? fileURLToPath(modulePath) : modulePath;
  // eslint-disable-next-line no-underscore-dangle -- Compiler bootstrap contract.
  return globalThis.__openclawStandaloneIsEmbeddedModule?.(filename) === true;
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

/** Startup hooks can own a separate compiler/reaper; source filenames cannot prove that. */
export function runtimeHasSourceLoader() {
  // BUN_BE_BUN executes disk programs, even when the executable has a manifest.
  if (process.env.BUN_BE_BUN !== "1" && isStandaloneRuntimeExecutable()) {
    return false;
  }
  return hasNodeStartupHooks(process.execArgv, process.env.NODE_OPTIONS);
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

/** Bind only this CLI child to its launcher; runtime flags belong before a loose entry. */
export function resolveOpenClawCliRespawn({ env = process.env, ...params } = {}) {
  const execPath = params.execPath ?? process.execPath;
  const invocation = resolveOpenClawCliInvocation({
    ...params,
    execArgv: ["--import", CLI_PARENT_BOUND_PRELOAD, ...(params.execArgv ?? process.execArgv)],
  });
  return {
    ...invocation,
    env: isStandaloneRuntimeExecutable(execPath)
      ? { ...env, [CLI_RESPAWN_PARENT_ENV]: String(process.pid) }
      : env,
  };
}
