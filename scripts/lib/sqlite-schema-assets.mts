import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";

/** Keep diagnostic catalogs lazy in installed packages and sealed worker archives. */
export function createSqliteSchemaAssetsPlugin(
  rootDir = process.cwd(),
  recordInput?: (file: string) => void,
  options: { workerChunks?: boolean } = {},
): TsdownPlugin {
  const directory = fs.realpathSync(path.resolve(rootDir, "src/state/postgres-schema.generated"));
  return {
    name: "openclaw:sqlite-schema-assets",
    transform(code, id) {
      if (
        path.dirname(path.normalize(id)) !== directory ||
        !/^sqlite-[a-z-]+-catalogs\.ts$/u.test(path.basename(id))
      ) {
        return undefined;
      }
      const reference = options.workerChunks
        ? /readFileSync\(\s*new URL\(\s*["']\.\/(sqlite-[\w-]+-catalogs\.json)["']\s*,\s*import\.meta\.url\s*\)\s*,\s*["']utf8["']\s*\)/gu
        : /new URL\(\s*["']\.\/(sqlite-[\w-]+-catalogs\.json)["']\s*,\s*import\.meta\.url\s*\)/gu;
      const transformed = code.replace(reference, (_reference, name: string) => {
        const source = path.join(directory, name);
        recordInput?.(source);
        this.addWatchFile(source);
        const json = fs.readFileSync(source, "utf8");
        const asset = this.emitFile({
          type: "asset",
          fileName: options.workerChunks
            ? `worker/worker-chunk-${name.replace(/\.json$/u, ".mjs")}`
            : `assets/sqlite-schema/${name}`,
          source: options.workerChunks ? `export default ${JSON.stringify(json)};\n` : json,
        });
        if (options.workerChunks) {
          return `createSqliteCatalogRequire(import.meta.url)(sqliteCatalogFileURLToPath(import.meta.ROLLUP_FILE_URL_${asset})).default`;
        }
        return `new URL(import.meta.ROLLUP_FILE_URL_${asset})`;
      });
      return {
        code:
          options.workerChunks && transformed !== code
            ? `import { createRequire as createSqliteCatalogRequire } from "node:module";\nimport { fileURLToPath as sqliteCatalogFileURLToPath } from "node:url";\n${transformed}`
            : transformed,
        map: null,
      };
    },
  };
}
