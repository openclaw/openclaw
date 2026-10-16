// Bootstrap-safe ownership of OpenClaw executable identity and CLI invocation shape.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Packaging owns hashes; launch planning consumes only the artifact identity. */
export function readStandaloneRuntimeManifest(executable = process.execPath) {
  if (!path.isAbsolute(executable)) {
    return undefined;
  }
  const root = path.dirname(executable);
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
  const sidecarRelative = path.relative(root, path.resolve(root, manifest.runtime.path));
  if (
    path.isAbsolute(manifest.executable.path) ||
    path.resolve(root, manifest.executable.path) !== path.resolve(executable) ||
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
    executable: { path: manifest.executable.path },
    runtime: { path: manifest.runtime.path },
    openclaw: { version: manifest.openclaw.version },
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
