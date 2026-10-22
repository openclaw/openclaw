import { readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  contained,
  isWithin,
  qualifiedPackage,
  toolingDependencyOptions,
} from "./tooling-dependencies.mjs";

export function nativeProtocolTooling(checkout) {
  const manifestPath = join(checkout, "packages/gateway-protocol/package.json");
  const tooling = toolingDependencyOptions(checkout, "native-protocol");
  if (!tooling.root) {
    return { build: createRequire(manifestPath)("esbuild").build, plugins: [] };
  }
  const { directory } = tooling.resolvePackage("esbuild", pathToFileURL(manifestPath).href);
  const require = createRequire(join(directory, "package.json"));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const nativeName = `@esbuild/${process.platform}-${process.arch}`;
  const nativeRoot = qualifiedPackage(
    manifest,
    tooling.root,
    nativeName,
    "native-protocol",
    directory,
    dirname(require.resolve(`${nativeName}/package.json`)),
  );
  const binary = contained(
    nativeRoot,
    require.resolve(
      `${nativeName}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`,
    ),
  );
  const override = process.env.ESBUILD_BINARY_PATH;
  if (override && realpathSync(override) !== binary) {
    throw new Error("Cannot qualify an overridden native protocol esbuild binary.");
  }
  const entry = contained(directory, require.resolve("esbuild"));
  if (require.cache[entry]) {
    throw new Error("Native protocol esbuild was already loaded; use a fresh Node process.");
  }
  // esbuild captures this path at module initialization. Bind its API to the
  // qualified binary; a cached API could retain an earlier override.
  let build;
  try {
    process.env.ESBUILD_BINARY_PATH = binary;
    ({ build } = require(entry));
  } finally {
    if (override === undefined) {
      delete process.env.ESBUILD_BINARY_PATH;
    } else {
      process.env.ESBUILD_BINARY_PATH = override;
    }
  }
  const resolving = {};
  return {
    build,
    plugins: [
      {
        name: "native-protocol-tooling",
        setup(bundler) {
          bundler.onEnd((result) => {
            // Check transitive and relative inputs too. A node_modules path name
            // alone does not prove that a foreign file belongs to the donor.
            for (const file of Object.keys(result.metafile?.inputs ?? {})) {
              const physical = realpathSync(resolve(checkout, file));
              if (!isWithin(checkout, physical)) {
                contained(realpathSync(join(tooling.root, "node_modules")), physical);
              }
            }
          });
          bundler.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (
              args.pluginData === resolving ||
              args.kind === "entry-point" ||
              isAbsolute(args.path) ||
              isBuiltin(args.path) ||
              !args.importer
            ) {
              return null;
            }
            const options = { kind: args.kind, pluginData: resolving };
            const local = await bundler.resolve(args.path, {
              ...options,
              resolveDir: args.resolveDir,
            });
            if (!local.errors.length) {
              if (isWithin(checkout, realpathSync(local.path))) {
                return local;
              }
            }
            const dependency = tooling.resolvePackage(args.path, pathToFileURL(args.importer).href);
            if (!dependency) {
              return null;
            }
            const resolved = await bundler.resolve(args.path, {
              ...options,
              resolveDir: dependency.resolveDir,
            });
            if (!resolved.errors.length) {
              contained(dependency.directory, resolved.path);
            }
            return resolved;
          });
        },
      },
    ],
  };
}
