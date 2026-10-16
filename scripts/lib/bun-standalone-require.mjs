import { createRequire } from "node:module";
import path from "node:path";

/** Capture native filename selection without resolving image-owned JavaScript at runtime. */
export function createStandaloneRequireAdapter({ runtimeRoot, embeddedPaths }) {
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
    bootstrap: `globalThis.__openclawStandaloneCreateRequire = (() => {
  const resolutions = ${JSON.stringify(resolutions)};
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
        const resolved = globalThis.__openclawStandaloneNativeResolve(parent, specifier);
        const entry = embedded(specifier) ?? embedded(resolved ?? imageFilename(specifier) ?? target.resolve(specifier));
        const loaded = Reflect.apply(target, receiver, [entry ?? resolved ?? specifier, ...rest]);
        return entry && commonJsEntries.has(entry) ? loaded.default ?? loaded : loaded;
      }
    });
  };
})();\n`,
  };
}
