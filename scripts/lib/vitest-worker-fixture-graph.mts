import path from "node:path";
import { fileURLToPath } from "node:url";

/** Close compiler output edges, with declarations supplying opaque runtime roots. */
export function createVitestWorkerFixtureGraph(outDir: string) {
  const chunks = new Map<string, { prefix: string; imports: string[] }>();
  const assets = new Set<string>();
  const normalize = (name: string) => name.replaceAll("\\", "/");
  return {
    chunk(prefix: string, name: string, imports: readonly string[]) {
      chunks.set(normalize(prefix + name), { prefix, imports: [...imports] });
    },
    asset(name: string) {
      if (!name.endsWith(".map")) {
        assets.add(normalize(name));
      }
    },
    select(roots: readonly string[]): string[] {
      // Assets lack complete consumer edges in Rolldown. Keep every emitted and
      // declaration-owned asset, including package-root paths outside dist/.
      const selected = new Set(assets);
      const visit = (name: string) => {
        if (selected.has(name)) {
          return;
        }
        const chunk = chunks.get(name);
        if (!chunk) {
          throw new Error("Fixture compiler output missing: " + name);
        }
        selected.add(name);
        for (const specifier of chunk.imports) {
          let target: string;
          let internal: boolean;
          if (specifier.startsWith("file:")) {
            const relative = normalize(path.relative(outDir, fileURLToPath(specifier)));
            internal = relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
            target = relative;
          } else {
            // OutputChunk imports are relative to the build output directory,
            // not to the importing chunk. Bare package identifiers stay external.
            target = path.posix.normalize(chunk.prefix + specifier);
            internal = chunks.has(target) || assets.has(target) || specifier.startsWith(".");
          }
          if (internal) {
            visit(target);
          }
        }
      };
      for (const root of roots) {
        visit(normalize(root));
      }
      return [...selected].sort();
    },
  };
}
