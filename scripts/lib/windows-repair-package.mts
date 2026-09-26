import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { list as listTar } from "tar";
import { hashFile } from "./gateway-bench-installed-package.ts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "./package-lifecycle-marker.mjs";
import { isRecord } from "./record-shared.mjs";

export type PackagedOwnerEvidence = {
  file: string;
  sha256: string;
  exports?: Record<string, string>;
};

export async function verifyPackageMember(packageRoot: string, tarball: string, file: string) {
  const relative = path.relative(packageRoot, file).replaceAll(path.sep, "/");
  assert.ok(relative.startsWith("dist/") && !relative.split("/").includes(".."));
  const bytes = execFileSync("tar", ["-xOf", tarball, `package/${relative}`], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
    sha256,
    `Installed module differs from the bound package: ${relative}`,
  );
  return { file: relative, sha256 };
}

// Authenticate the installed package once, before any owner can import computed
// or transitive local modules. External npm dependencies are installed separately.
export async function createPackagedOwnerLoader(installedRoot: string, tarball: string) {
  assert.ok(
    (await fs.lstat(installedRoot)).isDirectory(),
    "Installed package root must be a directory",
  );
  const packageRoot = await fs.realpath(installedRoot);
  const bindings = new Map<string, PackagedOwnerEvidence>();
  const errors: string[] = [];
  await listTar({
    file: tarball,
    strict: true,
    onReadEntry(entry) {
      const parts = entry.path.replace(/\/$/u, "").split("/");
      if (
        parts.shift() !== "package" ||
        parts.some((part) => !part || part === "." || part === ".." || /[\\:]/u.test(part))
      ) {
        errors.push(`Invalid package member: ${entry.path}`);
        return;
      }
      if (entry.type === "Directory") {
        return;
      }
      const relative = parts.join("/");
      if (entry.type !== "File" || !relative || bindings.has(relative)) {
        errors.push(`Unsupported or duplicate package member: ${entry.path}`);
        return;
      }
      // Published tarballs carry this marker; successful postinstall removes it.
      // A still-installed marker is rejected as an unbound member below.
      if (relative === PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH) {
        return;
      }
      const binding = { file: relative, sha256: "" };
      bindings.set(relative, binding);
      const hash = createHash("sha256");
      entry.on("data", (chunk: Buffer) => hash.update(chunk));
      entry.on("end", () => {
        binding.sha256 = hash.digest("hex");
      });
    },
  });
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.ok(bindings.size > 0, "Package tarball has no files");
  const directories = new Set<string>();
  for (const file of bindings.keys()) {
    for (
      let parent = path.posix.dirname(file);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      directories.add(parent);
    }
  }
  function isExternalDependency(relative: string) {
    const segments = relative.split("/");
    if (segments[0] !== "node_modules") {
      return false;
    }
    const root = segments.slice(0, segments[1]?.startsWith("@") ? 3 : 2).join("/");
    return !bindings.has(root) && !directories.has(root);
  }
  const missing = new Set(bindings.keys());
  async function verifyDirectory(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(packageRoot, file).replaceAll(path.sep, "/");
      // Only top-level dependency roots may belong to npm instead of the archive.
      // Once inside a bundled package, nested dependencies must remain bound too.
      if (isExternalDependency(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        await verifyDirectory(file);
      } else {
        const binding = bindings.get(relative);
        assert.ok(entry.isFile() && binding, `Unbound installed package member: ${relative}`);
        assert.equal(
          await hashFile(file),
          binding.sha256,
          `Installed module differs from the bound package: ${relative}`,
        );
        missing.delete(relative);
      }
    }
  }
  await verifyDirectory(packageRoot);
  assert.equal(missing.size, 0, `Missing installed package members: ${[...missing].join(", ")}`);
  function localMember(url: string) {
    if (!url.startsWith("file:")) {
      return undefined;
    }
    const relative = path.relative(packageRoot, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      return undefined;
    }
    return isExternalDependency(relative) ? undefined : relative;
  }
  function boundMember(url: string, required = false) {
    const relative = localMember(url);
    if (relative === undefined && !required) {
      return undefined;
    }
    const binding = relative === undefined ? undefined : bindings.get(relative);
    assert.ok(binding, `Unbound installed package member: ${relative ?? url}`);
    return binding;
  }
  const manifestBinding = bindings.get("package.json");
  assert.ok(manifestBinding, "Package tarball has no package.json");
  const manifestSha256 = manifestBinding.sha256;
  function readBoundManifest() {
    const bytes = readFileSync(path.join(packageRoot, "package.json"));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      manifestSha256,
      "Installed module differs from the bound package: package.json",
    );
    return bytes;
  }
  const manifest: unknown = JSON.parse(readBoundManifest().toString("utf8"));
  assert.ok(isRecord(manifest) && typeof manifest.name === "string", "Missing package name");
  const packageName = manifest.name;
  // Keep the import's actual source bound through lazy imports and require(), not
  // just the initial scan. The observer owns this hook until its process finishes.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      let required = false;
      const parent = context.parentURL ? localMember(context.parentURL) : undefined;
      if (parent !== undefined) {
        readBoundManifest();
      }
      if (path.isAbsolute(specifier)) {
        required = localMember(pathToFileURL(specifier).href) !== undefined;
      } else if (specifier.startsWith("file:") || specifier.startsWith(".")) {
        required = localMember(new URL(specifier, context.parentURL).href) !== undefined;
      } else if (parent !== undefined && !isBuiltin(specifier) && !specifier.includes(":")) {
        // OpenClaw artifacts have no external # aliases. Internal aliases and
        // self-references must remain archive-bound; bare npm dependencies may not.
        required =
          specifier.startsWith("#") ||
          specifier === packageName ||
          specifier.startsWith(`${packageName}/`);
        const dependency = specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1)
          .join("/");
        // Preserve Node's extension and package resolution, including bundled CJS.
        // An archive-owned dependency cannot escape via a replacement symlink.
        for (
          let directory: string | undefined = path.posix.dirname(parent);
          directory;
          directory = directory === "." ? undefined : path.posix.dirname(directory)
        ) {
          if (directories.has(path.posix.join(directory, "node_modules", dependency))) {
            required = true;
            break;
          }
        }
      }
      const resolved = nextResolve(specifier, context);
      boundMember(resolved.url, required);
      return resolved;
    },
    load(url, context, nextLoad) {
      const binding = boundMember(url);
      const loaded = nextLoad(url, context);
      if (binding) {
        assert.ok(loaded.source != null, `Missing module source: ${binding.file}`);
        const source =
          loaded.source instanceof ArrayBuffer ? new Uint8Array(loaded.source) : loaded.source;
        assert.equal(
          createHash("sha256").update(source).digest("hex"),
          binding.sha256,
          `Installed module differs from the bound package: ${binding.file}`,
        );
      }
      return loaded;
    },
  });
  let disposed = false;
  return Object.assign(
    (stem: string, names: readonly string[], evidence: PackagedOwnerEvidence[]) => {
      assert.ok(!disposed, "Packaged owner loader is disposed");
      return loadPackagedOwner(packageRoot, bindings, stem, names, evidence);
    },
    {
      [Symbol.dispose]: () => {
        disposed = true;
        hooks.deregister();
      },
    },
  );
}

type Callable = (...args: unknown[]) => unknown;
function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

// Use named owner exports, never coincidental minified function names. Missing or
// ambiguous owners fail instead of replacing production authority in the fixture.
async function loadPackagedOwner(
  packageRoot: string,
  bindings: ReadonlyMap<string, PackagedOwnerEvidence>,
  stem: string,
  names: readonly string[],
  evidence: PackagedOwnerEvidence[],
) {
  const matches = new Map<string, Array<{ file: string; alias: string }>>();
  for (const name of await fs.readdir(path.join(packageRoot, "dist"))) {
    if (!name.startsWith(`${stem}-`) || !/\.[cm]?js$/u.test(name)) {
      continue;
    }
    const file = path.join(packageRoot, "dist", name);
    const source = await fs.readFile(file, "utf8");
    const aliases = new Map<string, string>();
    for (const clause of source.matchAll(/export\s*\{([^}]+)\}/gu)) {
      assert.ok(clause[1]);
      for (const entry of clause[1].split(",")) {
        const match = /^\s*([$\w]+)(?:\s+as\s+([$\w]+))?\s*$/u.exec(entry);
        if (match?.[1]) {
          aliases.set(match[1], match[2] ?? match[1]);
        }
      }
    }
    for (const [symbol, alias] of aliases) {
      if (!names.includes(symbol)) {
        continue;
      }
      const owners = matches.get(symbol) ?? [];
      owners.push({ file, alias });
      matches.set(symbol, owners);
    }
  }
  const selected = new Map<string, Map<string, string>>();
  for (const name of names) {
    const owners = matches.get(name) ?? [];
    assert.equal(owners.length, 1, `Expected one packaged ${stem} owner for ${name}`);
    const match = owners[0];
    assert.ok(match);
    const aliases = selected.get(match.file) ?? new Map<string, string>();
    aliases.set(name, match.alias);
    selected.set(match.file, aliases);
  }
  const owner: Record<string, Callable> = {};
  for (const [file, aliases] of selected) {
    const namespace: Record<string, unknown> = await import(pathToFileURL(file).href);
    const exports: Record<string, string> = {};
    for (const [name, alias] of aliases) {
      const value: unknown = namespace[alias];
      assert.ok(isCallable(value), `Missing callable ${name}`);
      owner[name] = value;
      exports[name] = alias;
    }
    const binding = bindings.get(path.relative(packageRoot, file).replaceAll(path.sep, "/"));
    assert.ok(binding);
    evidence.push({ ...binding, exports });
  }
  return owner;
}
