import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import { directoryIdFilter } from "./rolldown-id-filter.mts";

const schemaAssetDirectory = "src/state/postgres-schema.generated";
const sqliteAssetPattern = /^sqlite-[a-z-]+-catalogs\.json$/u;
const postgresAssetPattern = /^postgres-(?:agent-search-|agent-)?runtime-[\w]+\.ts$/u;
const loaderPattern = /^(?:sqlite-[a-z-]+-catalogs|(?:agent-search-|agent-)?runtime)\.ts$/u;

/** All lazy payloads participate in build fingerprints and reduced source inputs. */
export function resolveDatabaseSchemaAssetInputs(rootDir = process.cwd()): string[] {
  const directory = fs.realpathSync(path.resolve(rootDir, schemaAssetDirectory));
  return fs
    .readdirSync(directory)
    .filter((name) => sqliteAssetPattern.test(name) || postgresAssetPattern.test(name))
    .toSorted()
    .map((name) => path.join(directory, name));
}

/** Include lazy catalogs in build fingerprints and reduced source checkouts. */
export function resolveSqliteSchemaAssetInputs(rootDir = process.cwd()): string[] {
  const directory = fs.realpathSync(path.resolve(rootDir, schemaAssetDirectory));
  return fs
    .readdirSync(directory)
    .filter((name) => sqliteAssetPattern.test(name))
    .toSorted()
    .map((name) => path.join(directory, name));
}

/** Keep database payloads lazy in installed packages and sealed worker archives. */
export function createDatabaseSchemaAssetsPlugin(
  rootDir = process.cwd(),
  recordInput?: (file: string) => void,
  options: { workerChunks?: boolean } = {},
): TsdownPlugin {
  const directory = fs.realpathSync(path.resolve(rootDir, schemaAssetDirectory));
  return {
    name: "openclaw:database-schema-assets",
    transform: {
      filter: directoryIdFilter(
        directory,
        /(?:sqlite-[a-z-]+-catalogs|(?:agent-search-|agent-)?runtime)\.ts/u,
      ),
      handler(code, id) {
        if (
          path.dirname(path.normalize(id)) !== directory ||
          !loaderPattern.test(path.basename(id))
        ) {
          return undefined;
        }
        const reference =
          /createRequire\(\s*import\.meta\.url\s*\)\(\s*["']\.\/(sqlite-[\w-]+-catalogs\.json|postgres-[\w-]+\.ts)["']\s*,?\s*\)/gu;
        const transformed = code.replace(reference, (_reference, name: string) => {
          const source = path.join(directory, name);
          recordInput?.(source);
          this.addWatchFile(source);
          const contents = fs.readFileSync(source, "utf8");
          const postgres = postgresAssetPattern.test(name);
          const emittedName = postgres ? name.replace(/\.ts$/u, ".mjs") : name;
          const asset = this.emitFile({
            type: "asset",
            fileName: options.workerChunks
              ? `worker/worker-chunk-${emittedName.replace(/\.json$/u, ".mjs")}`
              : `assets/${postgres ? "postgres" : "sqlite"}-schema/${emittedName}`,
            source:
              options.workerChunks && !postgres
                ? `export default ${JSON.stringify(contents)};\n`
                : contents,
          });
          const load = `createRequire(import.meta.url)(schemaAssetFileURLToPath(import.meta.ROLLUP_FILE_URL_${asset}))`;
          return options.workerChunks && !postgres ? `JSON.parse(${load}.default)` : load;
        });
        return {
          code:
            transformed !== code
              ? `import { fileURLToPath as schemaAssetFileURLToPath } from "node:url";\n${transformed}`
              : transformed,
          map: null,
        };
      },
    },
  };
}
