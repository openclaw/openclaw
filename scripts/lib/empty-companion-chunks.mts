import path from "node:path";
import type { TsdownPlugin } from "tsdown";

/** Remove compiler-created no-op companions, never public entrypoints. */
export function createEmptyCompanionChunksPlugin() {
  return {
    name: "openclaw:empty-companion-chunks",
    generateBundle: {
      order: "pre",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((chunk) => chunk.type === "chunk");
        for (const chunk of chunks) {
          if (
            chunk.isEntry ||
            chunk.isDynamicEntry ||
            chunk.imports.length > 0 ||
            chunk.dynamicImports.length > 0 ||
            chunk.exports.length > 0 ||
            chunk.code.trim() !== "export {};"
          ) {
            continue;
          }
          const replacements: { consumer: (typeof chunks)[number]; start: number; end: number }[] =
            [];
          let safe = true;
          for (const consumer of chunks) {
            if (consumer.dynamicImports.includes(chunk.fileName)) {
              safe = false;
              break;
            }
            if (!consumer.imports.includes(chunk.fileName)) {
              continue;
            }
            let relative = path.posix.relative(
              path.posix.dirname(consumer.fileName),
              chunk.fileName,
            );
            if (!relative.startsWith(".")) {
              relative = "./" + relative;
            }
            const references = this.parse(consumer.code).body.filter(
              (node) =>
                (node.type === "ImportDeclaration" ||
                  node.type === "ExportNamedDeclaration" ||
                  node.type === "ExportAllDeclaration") &&
                node.source?.value === relative,
            );
            if (
              references.length === 0 ||
              references.some(
                (node) => node.type !== "ImportDeclaration" || node.specifiers.length > 0,
              )
            ) {
              safe = false;
              break;
            }
            for (const node of references) {
              replacements.push({ consumer, start: node.start, end: node.end });
            }
          }
          if (!safe) {
            continue;
          }
          for (const { consumer, start, end } of replacements) {
            // Keep offsets and newlines stable for existing source maps. Post-order metadata
            // plugins observe these final bytes and the reduced import graph.
            consumer.code =
              consumer.code.slice(0, start) +
              consumer.code.slice(start, end).replace(/[^\r\n]/g, " ") +
              consumer.code.slice(end);
            consumer.imports = consumer.imports.filter((name) => name !== chunk.fileName);
          }
          delete bundle[chunk.fileName];
        }
      },
    },
  } satisfies TsdownPlugin;
}
