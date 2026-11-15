import { createRequire } from "node:module";
import path from "node:path";

const BUILTIN_MARKER = "__OPENCLAW_STANDALONE_BUILTIN_REQUIRES__";

/**
 * Capture native filename selection without resolving image-owned JavaScript at runtime.
 * @param {{runtimeRoot: string, embeddedPaths: Record<string, string>,
 *   pluginLoader?: {specifier: string}}} options
 */
export function createStandaloneRequireAdapter({ runtimeRoot, embeddedPaths, pluginLoader }) {
  const nativeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const requests = new Set();
  for (const entry of Object.keys(embeddedPaths)) {
    if (entry.startsWith("../") || !/\.[cm]?js$/.test(entry)) {
      continue;
    }
    requests.add(entry.replace(/\.[cm]?js$/, ""));
    if (/^index\.[cm]?js$/.test(path.basename(entry))) {
      requests.add(path.dirname(entry));
    }
  }
  const resolutions = {};
  for (const request of requests) {
    let filename;
    try {
      filename = nativeRequire.resolve(path.join(runtimeRoot, request));
    } catch (error) {
      if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") {
        continue;
      }
      throw error;
    }
    const relative = path.relative(runtimeRoot, filename).split(path.sep).join("/");
    if (Object.hasOwn(embeddedPaths, relative)) {
      const key = path
        .relative(runtimeRoot, path.join(runtimeRoot, request))
        .split(path.sep)
        .join("/");
      resolutions[key] = relative;
    }
  }
  return {
    resolutions,
    finalize(builtinModules) {
      return {
        search: JSON.stringify(BUILTIN_MARKER),
        replacement:
          "{" +
          [...builtinModules]
            // Image aliases such as ws retain their full-package implementation.
            .filter((specifier) => !Object.hasOwn(embeddedPaths, specifier))
            .toSorted((left, right) => left.localeCompare(right))
            .map(
              (specifier) =>
                `${JSON.stringify(specifier)}: () => import.meta.require(${JSON.stringify(specifier)})`,
            )
            .join(",") +
          "}",
      };
    },
    bootstrap: `globalThis.__openclawStandaloneCreateRequire = (() => {
  const resolutions = ${JSON.stringify(resolutions)};
  const builtinRequires = ${JSON.stringify(BUILTIN_MARKER)};
  return (create, ...args) => {
    const require = create(...args);
    const parent = typeof args[0] === "string" && !args[0].startsWith("file:")
      ? args[0] : fileURLToPath(args[0]);
    const imageFilename = (specifier) => {
      if (typeof specifier !== "string") return undefined;
      const filename = path.isAbsolute(specifier) ? path.resolve(specifier)
        : specifier.startsWith("./") || specifier.startsWith("../")
          ? path.resolve(path.dirname(parent), specifier) : undefined;
      if (filename === undefined) return undefined;
      if (embedded(filename)) return filename;
      const key = path.relative(root, filename).split(path.sep).join("/");
      return Object.hasOwn(resolutions, key) ? path.join(root, resolutions[key]) : undefined;
    };
    // Keep physical filenames for admission/cache owners, while loading the mapped image entry.
    const resolve = new Proxy(require.resolve, {
      get(target, property, receiver) {
        if (property === "paths") return (specifier) =>
          globalThis.__openclawStandaloneNativeResolvePaths(parent, specifier) ?? target.paths(specifier);
        return Reflect.get(target, property, receiver);
      },
      apply(target, receiver, [specifier, ...rest]) {
        return (rest[0] === undefined ? globalThis.__openclawStandaloneNativeResolve(parent, specifier) ?? imageFilename(specifier) : undefined)
          ?? Reflect.apply(target, receiver, [specifier, ...rest]);
      }
    });
    return new Proxy(require, {
      get(target, property, receiver) {
        return property === "resolve" ? resolve : Reflect.get(target, property, receiver);
      },
      apply(target, receiver, [specifier, ...rest]) {
        if (typeof specifier !== "string") return Reflect.apply(target, receiver, [specifier, ...rest]);
        if (Object.hasOwn(builtinRequires, specifier)) return builtinRequires[specifier]();
        const resolved = globalThis.__openclawStandaloneNativeResolve(parent, specifier);
        // Admitted native addons keep their physical paths and use the native loader.
        if (resolved?.endsWith(".node")) {
          if (require.cache[resolved]) return require.cache[resolved].exports;
          const module = new (require("node:module").Module)(resolved);
          module.filename = resolved;
          require.cache[resolved] = module;
          try {
            process.dlopen(module, resolved);
            module.loaded = true;
            return module.exports;
          } catch (error) {
            delete require.cache[resolved];
            throw error;
          }
        }
        const entry = embedded(specifier) ?? embedded(resolved ?? imageFilename(specifier) ?? target.resolve(specifier));
        const loaded = entry ? import.meta.require(entry) : Reflect.apply(target, receiver, [resolved ?? specifier, ...rest]);
        return entry && commonJsEntries.has(entry) ? loaded.default ?? loaded : loaded;
      }
    });
  };
})();
${
  pluginLoader
    ? `const loadStandalonePluginRuntime = (() => {
  let runtime;
  return () => {
    // The literal external edge admits disk code; the relocated parent owns package lookup.
    return runtime ??= createRequire(path.join(root, "package.json"))(${JSON.stringify(pluginLoader.specifier)});
  };
})();
globalThis.openclawStandaloneLoadJitiFactory = () => loadStandalonePluginRuntime().createJiti;\n`
    : ""
}`,
  };
}

/** Transfer compiled exports to interpreted plugins without reading virtual source files. */
export function createStandaloneExternalModuleBootstrap() {
  return `const imageNamespace = "openclaw-image";
globalThis.__openclawStandaloneExternalModulePath = (filename) => {
  // The compiled require adapter already passes image paths to the native loader.
  if (filename.startsWith("/$bunfs/")) return undefined;
  const entry = embedded(filename);
  if (entry) ensureImageExports();
  return entry ? imageNamespace + ":" + entry : undefined;
};
globalThis.__openclawStandaloneExternalModuleResolution = (filename) => {
  const entry = embedded(filename);
  if (entry) ensureImageExports();
  return { path: entry ?? filename, namespace: entry ? imageNamespace : "file" };
};
let imageExportsRegistered = false;
let requireImageModule;
// Keep the onLoad hook inactive until a disk import needs image exports.
function ensureImageExports() {
  if (imageExportsRegistered) return;
  Bun.plugin({ name: "openclaw-image-exports", setup(build) {
    build.onLoad({ filter: /.*/, namespace: imageNamespace }, ({ path: filename }) => {
      requireImageModule ??= globalThis.__openclawStandaloneCreateRequire(createRequire, path.join(root, "package.json"));
      const loaded = requireImageModule(filename);
      if (commonJsEntries.has(filename)) {
        return { exports: { ...loaded, __esModule: true, default: loaded }, loader: "object" };
      }
      // ESM consumers retain every named export as well as the original default.
      const { __esModule: _interop, ...exports } = loaded;
      return { exports, loader: "object" };
    });
  }});
  imageExportsRegistered = true;
}`;
}

/** Route disk imports to their embedded module without changing the compiled loader. */
export function createStandaloneModuleResolverBootstrap() {
  return `let resolving = false;
if (isMainThread) Bun.plugin({ name: "openclaw-embedded-modules", setup(build) {
  // Bun checks the filter against the compiled entry before invoking callbacks.
  const filter = new RegExp("^(?!" + RegExp.escape(Bun.main) + "(?![\\\\s\\\\S]))");
  build.onResolve({ filter }, ({path: specifier, importer, kind}) => {
    // Re-entering the disk bridge while requiring an image exposes partial exports.
    if (specifier.startsWith("/$bunfs/")) return;
    if (kind === "require-resolve" || resolving || specifier.startsWith("node:") || specifier.startsWith("bun:")) return;
    let target;
    try {
      resolving = true;
      target = globalThis.__openclawStandaloneNativeResolve(importer || path.join(root, "openclaw.mjs"), specifier)
        ?? (specifier.startsWith("file:") ? fileURLToPath(specifier)
        : path.isAbsolute(specifier) ? specifier
        : (() => {
          try { return Bun.resolveSync(specifier, importer ? path.dirname(importer) : root); }
          catch { return Bun.resolveSync(specifier, root); }
        })());
    } catch { return; } finally { resolving = false; }
    const entry = embedded(target);
    if (entry) return globalThis.__openclawStandaloneExternalModuleResolution(entry);
  });
}});`;
}
