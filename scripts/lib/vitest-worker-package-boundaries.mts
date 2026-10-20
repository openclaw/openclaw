import { createRequire } from "node:module";
import path from "node:path";
import type { Rolldown } from "tsdown";

/** Native adapters keep dependency resolution with the plugin that owns each package. */
export function createVitestWorkerPackageBoundariesPlugin(
  root: string,
  recordInput: (source: string) => void,
): Rolldown.Plugin {
  const quickjs = path.join(root, "extensions/code-mode-quickjs/src/quickjs-runtime.ts");
  const discord = path.join(root, "extensions/discord/src/voice/sdk-runtime.ts");
  return {
    name: "openclaw:worker-package-boundaries",
    resolveId: {
      order: "pre",
      handler(id, importer) {
        if (!importer || !id.startsWith(".")) {
          return null;
        }
        const source = path.resolve(path.dirname(importer), id).replace(/\.js$/u, ".ts");
        if (source !== quickjs && source !== discord) {
          return null;
        }
        recordInput(source);
        if (source === quickjs) {
          // Snapshot fixtures patch the plugin's own installed QuickJS instance.
          recordInput(createRequire(source).resolve("quickjs-wasi"));
        }
        return { id: source, external: "relative" };
      },
    },
  };
}

/** Resolve absolute internal boundaries from the output, never the compiler source base. */
export function createVitestWorkerRelativeExternalsPlugin(root: string): Rolldown.Plugin {
  const rootDirectory = path.resolve(root);
  return {
    name: "openclaw:worker-relative-externals",
    // Relative externals use the source base unless their output paths are explicit.
    outputOptions(options) {
      const destination = options.dir ?? (options.file && path.dirname(options.file));
      if (!destination) {
        throw new Error("Compiled subprocess package boundaries require an output directory");
      }
      const previous = options.paths;
      return {
        ...options,
        paths(id) {
          const source = path.normalize(id);
          if (path.isAbsolute(source) && source.startsWith(`${rootDirectory}${path.sep}`)) {
            const relative = path
              .relative(path.resolve(rootDirectory, destination), source)
              .replaceAll("\\", "/");
            return relative.startsWith(".") ? relative : `./${relative}`;
          }
          return typeof previous === "function" ? previous(id) : (previous?.[id] ?? id);
        },
      };
    },
  };
}
