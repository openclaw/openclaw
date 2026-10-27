import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { readTsconfig } = createRequire(require.resolve("tsdown"))("rolldown-plugin-dts/internal");

/** Describe the native project without relocating the repository's inherited type inputs. */
export function createStandaloneSourceProject({
  sourceRoot,
  runtimeRoot,
  projectFile,
  entrypoints,
}) {
  const directory = path.dirname(projectFile);
  let rootDir = path.resolve(sourceRoot);
  const runtime = path.resolve(runtimeRoot);
  for (;;) {
    const relative = path.relative(rootDir, runtime);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      break;
    }
    const parent = path.dirname(rootDir);
    if (parent === rootDir) {
      throw new Error("Standalone source and runtime require a common filesystem root");
    }
    rootDir = parent;
  }
  const sourceConfig = path.join(sourceRoot, "tsconfig.json");
  const { config } = readTsconfig(sourceConfig);
  const typeRoots = [];
  if (config.compilerOptions?.typeRoots === undefined) {
    // Implicit ambient lookup belongs to the source config, not the staging directory.
    for (
      let typeDirectory = path.dirname(sourceConfig);
      ;
      typeDirectory = path.dirname(typeDirectory)
    ) {
      typeRoots.push(path.join(typeDirectory, "node_modules", "@types"));
      if (path.dirname(typeDirectory) === typeDirectory) {
        break;
      }
    }
  }
  return {
    extends: sourceConfig,
    // Inherited outDir otherwise makes the relocated config directory the default rootDir.
    compilerOptions: {
      rootDir,
      allowJs: true,
      ...(config.compilerOptions?.typeRoots === undefined ? { typeRoots } : {}),
    },
    files: entrypoints.map((filename) =>
      path.relative(directory, filename).split(path.sep).join("/"),
    ),
  };
}
