import { Transform } from "node:stream";

//#region node_modules/@openclaw/fs-safe/dist/archive-limits.d.ts
type ArchiveExtractLimits = {
  /**
   * Max archive file bytes (compressed).
   */
  maxArchiveBytes?: number; /** Max number of extracted entries (files + dirs). */
  maxEntries?: number; /** Max extracted bytes (sum of all files). */
  maxExtractedBytes?: number; /** Max extracted bytes for a single file entry. */
  maxEntryBytes?: number;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive-kind.d.ts
type ArchiveKind = "tar" | "zip";
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive.d.ts
type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};
declare function extractArchive(params: {
  archivePath: string;
  destDir: string;
  timeoutMs: number;
  kind?: ArchiveKind;
  stripComponents?: number;
  tarGzip?: boolean;
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;
}): Promise<void>;
//#endregion
//#region src/infra/brew.d.ts
type BrewResolutionOptions = {
  homeDir?: string;
  /**
   * @deprecated No-op compatibility field for plugin SDK callers. Homebrew
   * env vars are ignored for resolution because workspace env can be untrusted.
   */
  env?: NodeJS.ProcessEnv;
};
declare function resolveBrewExecutable(opts?: BrewResolutionOptions): string | undefined;
//#endregion
export { extractArchive as n, resolveBrewExecutable as t };