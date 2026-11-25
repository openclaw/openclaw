import path from "node:path";
import type { TsdownPlugin } from "tsdown";

/** Drop no-op barrel companions that Rolldown retains in graphs with top-level await. */
export function createEmptyRuntimeChunksPlugin(): TsdownPlugin {
  return {
    name: "openclaw:empty-runtime-chunks",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      const empty = new Set(
        chunks
          .filter(
            (chunk) =>
              !chunk.isEntry &&
              !chunk.isDynamicEntry &&
              chunk.imports.length === 0 &&
              chunk.dynamicImports.length === 0 &&
              chunk.exports.length === 0 &&
              /^\s*export\s*\{\s*\};?\s*$/u.test(chunk.code),
          )
          .map((chunk) => chunk.fileName),
      );
      const removable = new Set(empty);
      if (empty.size === 0) {
        return;
      }
      const imports = new Map<string, Array<{ dependency: string; start: number; end: number }>>();
      for (const chunk of chunks) {
        for (const dependency of chunk.dynamicImports) {
          removable.delete(dependency);
        }
        const dependencies = new Set(chunk.imports.filter((dependency) => empty.has(dependency)));
        if (dependencies.size === 0) {
          continue;
        }
        const statements = [];
        for (const statement of this.parse(chunk.code).body) {
          if (statement.type !== "ImportDeclaration") {
            continue;
          }
          const dependency = path.posix.join(
            path.posix.dirname(chunk.fileName),
            statement.source.value,
          );
          if (!empty.has(dependency)) {
            continue;
          }
          if (statement.specifiers.length !== 0) {
            removable.delete(dependency);
          } else {
            dependencies.delete(dependency);
            statements.push({ dependency, start: statement.start, end: statement.end });
          }
        }
        // Namespace imports and re-exports can observe even an empty module.
        for (const dependency of dependencies) {
          removable.delete(dependency);
        }
        imports.set(chunk.fileName, statements);
      }
      for (const chunk of chunks) {
        for (const statement of (imports.get(chunk.fileName) ?? []).toReversed()) {
          if (!removable.has(statement.dependency)) {
            continue;
          }
          // Keep source-map offsets while removing only the side-effect import.
          chunk.code =
            chunk.code.slice(0, statement.start) +
            chunk.code.slice(statement.start, statement.end).replace(/[^\r\n]/gu, " ") +
            chunk.code.slice(statement.end);
        }
        chunk.imports = chunk.imports.filter((dependency) => !removable.has(dependency));
      }
      for (const fileName of removable) {
        const chunk = bundle[fileName];
        if (chunk?.type === "chunk" && chunk.sourcemapFileName) {
          delete bundle[chunk.sourcemapFileName];
        }
        delete bundle[fileName];
      }
    },
  };
}
