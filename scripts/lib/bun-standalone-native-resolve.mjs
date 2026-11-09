import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";

const requireConditions = new Set(["bun", "node", "require", "node-addons"]);
const absentEntryCodes = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
]);

function absentEntry(parent, specifier, dependency) {
  try {
    const target = moduleResolve(specifier, pathToFileURL(parent), requireConditions);
    if (target.protocol !== "file:") {
      return false;
    }
    if (/\.d\.[cm]?ts$/.test(target.pathname)) {
      return true;
    }
    // Legacy package resolution can return the manifest for a metadata-only package.
    return (
      !dependency.main &&
      dependency.exports == null &&
      specifier === dependency.name &&
      target.pathname.endsWith("/package.json") &&
      !fs
        .readdirSync(path.dirname(fileURLToPath(target)))
        .some((name) => /^index(?:\.[cm]?[jt]sx?|\.json|\.node)?$/.test(name))
    );
  } catch (error) {
    return absentEntryCodes.has(error.code);
  }
}

function capture(owners) {
  return owners.map(({ parent, dependencies }) => {
    const require = createRequire(parent);
    return Object.fromEntries(
      dependencies.map((dependency) => {
        const { name, exports } = dependency;
        const subpaths = Object.keys(exports ?? {}).filter(
          (key) => key.startsWith("./") && !key.includes("*"),
        );
        const entries = {};
        for (const specifier of [name, ...subpaths.map((key) => name + key.slice(1))]) {
          try {
            entries[specifier] = require.resolve(specifier);
          } catch (error) {
            // A separate filesystem resolver distinguishes absent/import-only entries
            // from Bun reporting MODULE_NOT_FOUND after its filename store fills.
            if (absentEntry(parent, specifier, dependency)) {
              continue;
            }
            throw new Error(
              `Cannot capture standalone export ${specifier} from ${parent}: ${error.message}`,
              { cause: error },
            );
          }
        }
        return [name, entries];
      }),
    );
  });
}

/** Resolve exports in a fresh process, before pruning their installation layout. */
export function resolveStandaloneNativeExports(owners) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    input: JSON.stringify(owners),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    const reason = child.error?.message ?? (child.stderr.trim() || child.signal || child.status);
    throw new Error(`Standalone export capture failed: ${reason}`);
  }
  return JSON.parse(child.stdout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(capture(JSON.parse(fs.readFileSync(0, "utf8")))));
}
